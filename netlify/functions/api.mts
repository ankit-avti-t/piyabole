import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, ne, or, ilike, asc, sql } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import { db } from "../../db/index.js";
import { users, sessions, groups, messages, events } from "../../db/schema.js";

type User = typeof users.$inferSelect;
type Message = typeof messages.$inferSelect;
type Group = typeof groups.$inferSelect;

const ONLINE_WINDOW_MS = 45_000;
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" };

function json(status: number, body: unknown) { return Response.json(body, { status, headers }); }
function id() { return randomUUID(); }
function hash(password: string) { return createHash("sha256").update(password).digest("hex"); }
function iso(value: Date | null | undefined) { return value ? new Date(value).toISOString() : null; }
function isOnline(user: User) { return !!user.lastSeenAt && Date.now() - new Date(user.lastSeenAt).getTime() < ONLINE_WINDOW_MS; }

function publicUser(user: User, self = false) {
  const visibility = (user.visibility || {}) as { gender?: boolean; bio?: boolean; bodyCount?: boolean };
  const result: Record<string, unknown> = { id: user.id, name: user.name, username: user.username, publicKey: user.publicKey || null, lastSeenAt: iso(user.lastSeenAt), onboardingComplete: user.onboardingComplete !== false, readReceipts: user.readReceipts !== false, avatar: user.avatar || "", profilePic: user.profilePic || "", initials: user.name.split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase(), online: isOnline(user) };
  result.profilePublic = self || user.profilePublic !== false;
  if (self || user.profilePublic !== false) {
    if (self || visibility.gender !== false) result.gender = user.gender || "";
    if (self || visibility.bio !== false) result.bio = user.bio || "";
    if (self || visibility.bodyCount === true) result.bodyCount = user.bodyCount || "";
    result.media = Array.isArray(user.media) ? user.media : [];
  }
  if (self) result.visibility = user.visibility;
  return result;
}
function publicMessage(message: Message) {
  const result: Record<string, unknown> = { id: message.id, senderId: message.senderId, text: message.text, attachment: message.attachment || null, reactions: message.reactions || {}, createdAt: iso(message.createdAt), seenAt: iso(message.seenAt) };
  if (message.groupId) result.groupId = message.groupId;
  else { result.receiverId = message.receiverId; result.encrypted = message.encrypted || null; }
  if (message.editedAt) result.editedAt = iso(message.editedAt);
  return result;
}
function publicGroup(group: Group) {
  return { id: group.id, name: group.name, type: group.type, ownerId: group.ownerId, memberIds: group.memberIds, createdAt: iso(group.createdAt) };
}
async function sendTo(userIds: string | string[], payload: unknown) {
  const targets = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (targets.length) await db.insert(events).values(targets.map(userId => ({ userId, payload })));
}
async function findUser(userId: string) { return (await db.select().from(users).where(eq(users.id, userId)))[0]; }
async function existingUserIds(ids: string[]) {
  if (!ids.length) return [];
  return (await db.select({ id: users.id }).from(users).where(inArray(users.id, ids))).map(row => row.id);
}
async function groupForUser(groupId: string, userId: string) {
  if (typeof groupId !== "string") return undefined;
  const group = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
  if (group && (group.type === "open" || (group.memberIds as string[]).includes(userId))) return group;
}
function conversationWhere(userId: string, otherId: string) {
  return or(and(eq(messages.senderId, userId), eq(messages.receiverId, otherId)), and(eq(messages.senderId, otherId), eq(messages.receiverId, userId)));
}
async function readBody(req: Request) { const raw = await req.text(); return raw ? JSON.parse(raw) : {}; }

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  try {
    if (method === "POST" && ["/api/register", "/api/login"].includes(route)) {
      const isRegister = route.endsWith("register");
      const input = await readBody(req);
      if (!input.username || !input.password || (isRegister && (!input.name || !input.dateOfBirth))) return json(400, { error: "Date of birth, username, name, and password are required." });
      const username = String(input.username).trim().toLowerCase();
      if (isRegister) {
        const normalizedName = String(input.name).trim().toLowerCase().replace(/\s+/g, "");
        if (username === normalizedName) return json(400, { error: "Username and name must be different." });
        const dateOfBirth = new Date(`${input.dateOfBirth}T00:00:00`);
        const youngestAllowed = new Date();
        youngestAllowed.setHours(0, 0, 0, 0);
        youngestAllowed.setFullYear(youngestAllowed.getFullYear() - 13);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || Number.isNaN(dateOfBirth.getTime()) || dateOfBirth > youngestAllowed) return json(400, { error: "You must be at least 13 years old to join Piya." });
      }
      let user = (await db.select().from(users).where(eq(users.username, username)))[0];
      if (isRegister) {
        if (user) return json(409, { error: "That username is already taken." });
        [user] = await db.insert(users).values({ id: id(), name: String(input.name).trim(), username, dateOfBirth: input.dateOfBirth, password: hash(input.password) }).returning();
      } else if (!user) return json(404, { error: "That username does not exist." });
      else if (user.password !== hash(input.password)) return json(401, { error: "Incorrect username or password." });
      const token = id();
      await db.insert(sessions).values({ token, userId: user.id });
      return json(200, { token, user: publicUser(user, true) });
    }

    const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
    const session = token ? (await db.select().from(sessions).where(eq(sessions.token, token)))[0] : undefined;
    const user = session ? await findUser(session.userId) : undefined;
    if (!user) return json(401, { error: "Please sign in first." });

    if (method === "GET" && route === "/api/events") {
      // Polling replaces the old WebSocket: it marks the user online and returns new events.
      await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
      if (Math.random() < 0.02) await db.delete(events).where(lt(events.createdAt, new Date(Date.now() - 86_400_000)));
      const after = Number(url.searchParams.get("after"));
      if (!url.searchParams.has("after") || !Number.isFinite(after)) {
        const [latest] = await db.select({ max: sql<number>`coalesce(max(${events.id}), 0)` }).from(events).where(eq(events.userId, user.id));
        return json(200, { cursor: Number(latest?.max || 0), events: [] });
      }
      const rows = await db.select().from(events).where(and(eq(events.userId, user.id), gt(events.id, after))).orderBy(asc(events.id)).limit(200);
      return json(200, { cursor: rows.length ? rows[rows.length - 1].id : after, events: rows.map(row => row.payload) });
    }
    if (method === "GET" && route === "/api/me") return json(200, { user: publicUser(user, true) });
    if (method === "GET" && route === "/api/account-state") return json(200, { state: user.accountState || {} });
    if (method === "PATCH" && route === "/api/account-state") {
      const input = await readBody(req);
      if (!input.state || typeof input.state !== "object" || Array.isArray(input.state)) return json(400, { error: "Invalid account state." });
      if (JSON.stringify(input.state).length > 30_000_000) return json(413, { error: "Account state is too large." });
      await db.update(users).set({ accountState: input.state }).where(eq(users.id, user.id));
      return json(200, { state: input.state });
    }
    if (method === "PATCH" && route === "/api/crypto-key") {
      const input = await readBody(req);
      if (!input.publicKey || input.publicKey.kty !== "EC" || input.publicKey.crv !== "P-256" || typeof input.publicKey.x !== "string" || typeof input.publicKey.y !== "string") return json(400, { error: "Invalid encryption key." });
      await db.update(users).set({ publicKey: input.publicKey }).where(eq(users.id, user.id));
      return json(200, { publicKey: input.publicKey });
    }
    if (method === "GET" && route === "/api/users/search") {
      const query = url.searchParams.get("q")?.trim().toLowerCase() || "";
      const pattern = `%${query.replace(/[\\%_]/g, x => `\\${x}`)}%`;
      const found = await db.select().from(users).where(and(ne(users.id, user.id), ilike(users.username, pattern))).limit(50);
      return json(200, { users: found.map(item => publicUser(item)) });
    }
    if (method === "GET" && route === "/api/users") {
      const rows = await db.select({ senderId: messages.senderId, receiverId: messages.receiverId }).from(messages).where(or(eq(messages.senderId, user.id), eq(messages.receiverId, user.id)));
      const connectedIds = [...new Set(rows.map(row => row.senderId === user.id ? row.receiverId : row.senderId))].filter((x): x is string => !!x && x !== user.id);
      const found = connectedIds.length ? await db.select().from(users).where(inArray(users.id, connectedIds)) : [];
      return json(200, { users: found.map(item => publicUser(item)) });
    }
    if (method === "GET" && route === "/api/friends") {
      const friendIds = (Array.isArray((user.accountState as any)?.friendIds) ? (user.accountState as any).friendIds : []).filter((x: unknown) => typeof x === "string" && x !== user.id);
      const found = friendIds.length ? await db.select().from(users).where(inArray(users.id, friendIds)) : [];
      return json(200, { users: found.map(item => publicUser(item)) });
    }
    if (method === "PATCH" && route.startsWith("/api/friends/")) {
      const friendId = route.split("/").pop()!;
      if (friendId === user.id || !(await findUser(friendId))) return json(404, { error: "Friend not found." });
      const input = await readBody(req);
      if (typeof input.friend !== "boolean") return json(400, { error: "A friend setting is required." });
      const state = (user.accountState || {}) as Record<string, unknown>;
      const friendIds: string[] = Array.isArray(state.friendIds) ? state.friendIds as string[] : [];
      const accountState = { ...state, friendIds: input.friend ? [...new Set([...friendIds, friendId])] : friendIds.filter(x => x !== friendId) };
      await db.update(users).set({ accountState }).where(eq(users.id, user.id));
      return json(200, { friend: input.friend });
    }
    if (method === "GET" && route === "/api/groups") {
      const all = await db.select().from(groups).where(or(eq(groups.type, "open"), sql`${groups.memberIds} @> ${JSON.stringify([user.id])}::jsonb`)).orderBy(asc(groups.createdAt));
      return json(200, { groups: all.map(publicGroup) });
    }
    if (method === "POST" && route === "/api/groups") {
      const input = await readBody(req);
      const type = input.type === "open" ? "open" : input.type === "private" ? "private" : "";
      const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
      const selected: string[] = Array.isArray(input.memberIds) ? input.memberIds.filter((x: unknown) => typeof x === "string") : [];
      if (!name || !type) return json(400, { error: "Choose a group type and enter a group name." });
      const valid = new Set(await existingUserIds([...new Set([user.id, ...selected])]));
      const memberIds = [...new Set([user.id, ...selected])].filter(x => valid.has(x));
      const [group] = await db.insert(groups).values({ id: id(), name, type, ownerId: user.id, memberIds }).returning();
      return json(201, { group: publicGroup(group) });
    }
    if (method === "PATCH" && route.startsWith("/api/groups/") && route.endsWith("/members")) {
      const groupId = route.split("/")[3];
      const group = (await db.select().from(groups).where(eq(groups.id, groupId)))[0];
      if (!group) return json(404, { error: "Group not found." });
      if (group.ownerId !== user.id) return json(403, { error: "Only the group owner can add members." });
      const input = await readBody(req);
      const additions = await existingUserIds(Array.isArray(input.memberIds) ? input.memberIds.filter((x: unknown) => typeof x === "string") : []);
      const memberIds = [...new Set([user.id, ...(group.memberIds as string[]), ...additions])];
      const [updated] = await db.update(groups).set({ memberIds }).where(eq(groups.id, groupId)).returning();
      return json(200, { group: publicGroup(updated) });
    }
    if (method === "GET" && route.startsWith("/api/groups/") && route.endsWith("/messages")) {
      const groupId = route.split("/")[3];
      if (!(await groupForUser(groupId, user.id))) return json(403, { error: "You are not a member of this group." });
      const rows = await db.select().from(messages).where(eq(messages.groupId, groupId)).orderBy(asc(messages.createdAt));
      return json(200, { messages: rows.map(publicMessage) });
    }
    if (method === "POST" && route === "/api/group-messages") {
      const input = await readBody(req);
      const group = await groupForUser(input.groupId, user.id);
      if (!group) return json(403, { error: "You are not a member of this group." });
      const text = typeof input.text === "string" ? input.text.trim().slice(0, 4000) : "";
      const attachment = input.attachment;
      if (!text && !attachment) return json(400, { error: "A message or attachment is required." });
      if (attachment && (typeof attachment.name !== "string" || typeof attachment.type !== "string" || typeof attachment.data !== "string" || !attachment.data.startsWith("data:") || attachment.size > 15_000_000)) return json(400, { error: "Attachments must be valid files smaller than 15 MB." });
      const [row] = await db.insert(messages).values({ id: id(), groupId: group.id, senderId: user.id, text, attachment: attachment || null }).returning();
      const message = publicMessage(row);
      await sendTo((group.memberIds as string[]).filter(x => x !== user.id), { type: "group-message", message });
      return json(201, { message });
    }
    if (method === "GET" && route.startsWith("/api/messages/")) {
      const otherId = route.split("/").pop()!;
      let rows = await db.select().from(messages).where(conversationWhere(user.id, otherId)).orderBy(asc(messages.createdAt));
      if (user.readReceipts !== false) {
        const seenAt = new Date();
        const incoming = rows.filter(message => message.receiverId === user.id && !message.seenAt);
        if (incoming.length) {
          await db.update(messages).set({ seenAt }).where(inArray(messages.id, incoming.map(m => m.id)));
          await sendTo(otherId, { type: "seen", messageIds: incoming.map(m => m.id), seenAt: seenAt.toISOString(), seenBy: user.id });
          rows = rows.map(message => incoming.includes(message) ? { ...message, seenAt } : message);
        }
      }
      return json(200, { messages: rows.map(publicMessage) });
    }
    if (method === "POST" && route === "/api/messages") {
      const input = await readBody(req);
      const receiver = typeof input.receiverId === "string" ? await findUser(input.receiverId) : undefined;
      const attachment = input.attachment;
      const encrypted = input.encrypted;
      if (!receiver || (!input.text?.trim() && !attachment && !encrypted)) return json(400, { error: "A recipient and message are required." });
      if (encrypted && (typeof encrypted.iv !== "string" || typeof encrypted.data !== "string" || encrypted.data.length > 30_000_000)) return json(400, { error: "Encrypted message is invalid or too large." });
      if (attachment && (typeof attachment.name !== "string" || typeof attachment.type !== "string" || typeof attachment.data !== "string" || !attachment.data.startsWith("data:") || attachment.data.length > 20_000_000 || attachment.size > 15_000_000)) return json(400, { error: "Attachments must be valid files smaller than 15 MB." });
      const [row] = await db.insert(messages).values({
        id: id(), senderId: user.id, receiverId: receiver.id, encrypted: encrypted || null,
        text: encrypted ? "" : (typeof input.text === "string" ? input.text.trim() : ""),
        attachment: encrypted ? null : (attachment ? { name: attachment.name.slice(0, 160), type: attachment.type.slice(0, 120), size: attachment.size, data: attachment.data } : null),
      }).returning();
      const message = publicMessage(row);
      await sendTo(receiver.id, { type: "message", message });
      return json(201, { message });
    }
    if ((method === "PATCH" || method === "DELETE") && route.startsWith("/api/messages/")) {
      const messageId = route.split("/").pop()!;
      const message = (await db.select().from(messages).where(eq(messages.id, messageId)))[0];
      if (!message) return json(404, { error: "Message not found." });
      if (method === "PATCH") {
        const input = await readBody(req);
        const participant = message.senderId === user.id || message.receiverId === user.id;
        if (typeof input.reaction === "string") {
          const allowedReactions = ["❤️", "😂", "👍", "😮", "😢", "🔥"];
          if (!participant || !allowedReactions.includes(input.reaction)) return json(403, { error: "You cannot react to this message." });
          const reactions = { ...(message.reactions as Record<string, number>) };
          const reactors = { ...(message.reactors as Record<string, boolean>) };
          const reactionKey = `${user.id}:${input.reaction}`;
          if (reactors[reactionKey]) {
            delete reactors[reactionKey];
            reactions[input.reaction] = Math.max(0, (reactions[input.reaction] || 0) - 1);
          } else {
            reactors[reactionKey] = true;
            reactions[input.reaction] = (reactions[input.reaction] || 0) + 1;
          }
          const [row] = await db.update(messages).set({ reactions, reactors }).where(eq(messages.id, messageId)).returning();
          const updated = publicMessage(row);
          await sendTo((message.senderId === user.id ? message.receiverId : message.senderId)!, { type: "message-reaction", message: updated });
          return json(200, { message: updated });
        }
        if (input.encrypted && (typeof input.encrypted.iv !== "string" || typeof input.encrypted.data !== "string" || input.encrypted.data.length > 30_000_000)) return json(400, { error: "Encrypted message is invalid or too large." });
        if (message.senderId !== user.id) return json(403, { error: "You can only edit messages you sent." });
        let changes;
        if (input.encrypted) changes = { encrypted: input.encrypted, text: "", attachment: null, editedAt: new Date() };
        else {
          if (typeof input.text !== "string" || !input.text.trim()) return json(400, { error: "A message cannot be empty." });
          changes = { text: input.text.trim().slice(0, 4000), editedAt: new Date() };
        }
        const [row] = await db.update(messages).set(changes).where(eq(messages.id, messageId)).returning();
        const updated = publicMessage(row);
        if (message.receiverId) await sendTo(message.receiverId, { type: "message-updated", message: updated });
        return json(200, { message: updated });
      }
      if (message.senderId !== user.id) return json(403, { error: "You can only delete messages you sent." });
      await db.delete(messages).where(eq(messages.id, messageId));
      if (message.receiverId) await sendTo(message.receiverId, { type: "message-deleted", messageId });
      return json(200, { deleted: true, messageId, scope: "everyone" });
    }
    if (method === "DELETE" && route.startsWith("/api/conversations/")) {
      const otherId = route.split("/").pop()!;
      if (!(await findUser(otherId))) return json(404, { error: "Conversation not found." });
      await db.delete(messages).where(conversationWhere(user.id, otherId));
      await sendTo(otherId, { type: "conversation-deleted", userId: user.id });
      return json(200, { deleted: true });
    }
    if (method === "PATCH" && route === "/api/settings") {
      const input = await readBody(req);
      if (typeof input.readReceipts !== "boolean") return json(400, { error: "A read receipt setting is required." });
      const [updated] = await db.update(users).set({ readReceipts: input.readReceipts }).where(eq(users.id, user.id)).returning();
      return json(200, { user: publicUser(updated, true) });
    }
    if (method === "PATCH" && route === "/api/profile") {
      const input = await readBody(req);
      const allowedAvatars = ["🪐", "🌙", "⚡", "🌈", "🦋", "🐼", "🦊", "🐸", "👾", "🔥", "🌻", "🎧"];
      if (typeof input.bio !== "string" || typeof input.gender !== "string" || typeof input.bodyCount !== "string" || typeof input.profilePic !== "string" || (input.avatar !== "" && !allowedAvatars.includes(input.avatar)) || !Array.isArray(input.media) || input.media.length > 4) return json(400, { error: "Invalid profile data." });
      if (input.profilePic && (!input.profilePic.startsWith("data:image/") || input.profilePic.length > 8_000_000)) return json(400, { error: "Profile pictures must be images smaller than 8 MB." });
      const mediaSize = input.media.reduce((total: number, item: any) => total + (typeof item?.data === "string" ? item.data.length : 0), 0);
      if (mediaSize > 20_000_000 || input.media.some((item: any) => !["image", "video"].includes(item?.type) || typeof item.data !== "string" || !item.data.startsWith("data:") || (item.type === "video" && (typeof item.duration !== "number" || item.duration < 1 || item.duration > 7)))) return json(400, { error: "Media must be up to 4 images or 1–7 second videos." });
      const [updated] = await db.update(users).set({
        gender: input.gender.trim().slice(0, 40),
        bio: input.bio.trim().slice(0, 160),
        bodyCount: input.bodyCount.trim().slice(0, 20),
        avatar: input.avatar,
        profilePic: input.profilePic,
        profilePublic: input.profilePublic !== false,
        media: input.media.map((item: any) => ({ type: item.type, data: item.data, name: String(item.name || "").slice(0, 80), duration: item.type === "video" ? Number(item.duration.toFixed(2)) : null })),
        visibility: { gender: input.visibility?.gender === true, bio: input.visibility?.bio === true, bodyCount: input.visibility?.bodyCount === true },
        onboardingComplete: true,
      }).where(eq(users.id, user.id)).returning();
      return json(200, { user: publicUser(updated, true) });
    }
    if (method === "POST" && route === "/api/ai-chat") {
      const input = await readBody(req);
      if (!input.text?.trim()) return json(400, { error: "A message is required." });
      try {
        const gemini = new GoogleGenAI({});
        const result = await gemini.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          contents: input.text.trim(),
          config: { systemInstruction: "You are Piya AI, a warm, concise assistant inside a private chat app. Be helpful and conversational. Keep replies under 120 words unless the user asks for detail." }
        });
        return json(200, { text: result.text || "I could not generate a response this time." });
      } catch (error) {
        console.error("Gemini request failed:", error);
        return json(502, { error: "Piya AI is temporarily unavailable. Please try again in a moment." });
      }
    }
    if (method === "DELETE" && route === "/api/account") {
      await db.delete(messages).where(or(eq(messages.senderId, user.id), eq(messages.receiverId, user.id)));
      await db.delete(events).where(eq(events.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
      return json(200, { deleted: true });
    }
    return json(404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "The server could not complete that request." });
  }
};

export const config: Config = { path: "/api/*" };
