import { App } from "@slack/bolt";
import fs from "node:fs/promises"
import { CONFIG } from "./config";
import { store } from "./storage/fileStore";
import { logger } from "./logger";
import { getBalance } from "./economy";
import { createChallengeRecord, setChallengeRootMessage, acceptChallengeAndLockStake, declineChallenge, refundStakes, getChallenge } from "./challenge";
import { canStartBet } from "./economy";  
import { addTransaction } from "./ledger";
import { LogLevel } from "@slack/bolt";
import { scheduleJobs } from "./jobs";
import type { CodedError } from "@slack/bolt";

const COOLDOWN_MS = 1_500;
const cooldown = new Map<string, number>()

function isPlay(userId: string): boolean {
    const u = store.get().users[userId];
    return !!u?.play;
}

function onCooldown(key: string): boolean {
    const now = Date.now();
    const until = cooldown.get(key) || 0;
    if (now < until) return true;
    cooldown.set(key, now + COOLDOWN_MS);
    return false;
}

async function safeAddReaction(
    client: any,
    channel: string,
    ts: string,
    name: string,
    fallback?: string
) {
    try {
        await client.reactions.add({ channel, timestamp: ts, name });
    } catch (e) {
        if (fallback) {
            try {
                await client.reactions.add({ channel, timestamp: ts, name: fallback });
            } catch {

            }
        }
    }
}

function getMessageSurfaceIds(msg: any) : { channel?:string; ts?: string } {
    const channel = (msg as any).channel as string | undefined;
    const ts = (msg as any).ts as string | undefined;
    return { channel, ts};
}

function isChannelLike(id?: string) {
    // REMEMBER C = PUBLIC || G = PRIVATE || D = DM
    return !!id && (id.startsWith("C") || id.startsWith("G"));
}


function nowIso() { return new Date().toISOString(); }

function ensureUserInState(userId: string) {
    const s = store.get();
    if (!s.users[userId]) {
        s.users[userId] = {
            id: userId,
            play: false,
            see: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            stats: { currentStreak: 0, longestStreak: 0 },
        };
    }
    if (!s.balances[userId]) {
        s.balances[userId] = { userId, amount: 0, updatedAt: nowIso() };
    }
}

function parseUserMention(text: string): string | null {
    const m = text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/i);
    return m ? m [1] : null;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function maybeAwardSecretCoin(client: any, userId: string, reason = "game") {
  await store.update(s => {
    if (!(s as any).secretCoins) {
      (s as any).secretCoins = { globalCap: 3, awards: [] };
    }
  });

  const s = store.get();
  if (s.secretCoins.awards.length >= s.secretCoins.globalCap) return;

  if (Math.random() < 1 / 1_000_000) {
    await store.update(st => {
      st.secretCoins.awards.push({
        userId,
        at: new Date().toISOString(),
        reason
      });
    });

    try {
      const im = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: im.channel!.id!,
        text: "🪙 **Secret Coin found!** You discovered a 1-in-a-million coin. This persists across resets."
      });
    } catch {}
  }
}


async function runCoinFlip(client: any, challengeId: string) {
    const rec = getChallenge(challengeId);
    if (!rec) return;
    if (rec.state !== "accepted") return;
    if (rec.opponent.kind !== "user") return; 

    const channelId = rec.channel;
    const ts = rec.rootTs;
    const a = rec.challengerId;
    const b = rec.opponent.id;
    const coinSide = Math.random() < 0.5 ? "Heads" : "Tails";
    const winnerId = Math.random() < 0.5 ? a : b;
    const loserId = winnerId === a ? b : a;

    try {
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: "🪙 Flipping the coin…" });
        await sleep(700);
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `It lands on *${coinSide}*!` });
        await sleep(250);

        await addTransaction(winnerId, "win", rec.stake * 2, {
        refId: `challenge:${rec.id}`,
        idemKey: `challenge:${rec.id}:payout:${winnerId}`
        });

        await client.chat.postMessage({
        channel: channelId,
        thread_ts: ts,
        text: `🏆 <@${winnerId}> wins the pot (*${rec.stake}* net)!`
        });

        if (ts) {
        await client.chat.update({
            channel: channelId,
            ts,
            text: `Challenge resolved: <@${winnerId}> won.`,
            blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*Coin flip result:* <@${winnerId}> wins *${rec.stake}* net.` } }
            ]
        });
        }

        await store.update(s => {
            const g = (s.games as any)[rec.id];
            if (g) {
                g.state = "resolved";
                g.resolvedAt = new Date().toISOString();
                g.winnerId = winnerId;
                g.outcome = { game: rec.game, coinSide };
            }
        });

        await maybeAwardSecretCoin(client, winnerId);
        await maybeAwardSecretCoin(client, loserId);

        await applyWinStreak(winnerId);
        await applyLossStreak(loserId);

    } catch (e: any) {
        try {
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `⚠️ Error resolving game. Refunding stakes.` });
        } catch {}
        try { await refundStakes(rec.id); } catch {}
    }
}

type ChallengeParseOk = {
  ok: true;
  opponent: "dealer" | "user";
  opponentId?: string;
  game: "coin_flip" | "old_maid" | "poker" | "typing_battle";
  stake: number;
};
type ChallengeParseErr = { ok: false; error: string };
type ChallengeParse = ChallengeParseOk | ChallengeParseErr;

function parseChallengeArgs(txt: string): ChallengeParse {
  const parts = (txt || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return { ok: false, error: "Usage: /challenge @user|dealer [game] [amount]" };

  const target = parts[0].toLowerCase();
  let opponent: "dealer" | "user" = "user";
  let opponentId: string | undefined;

  if (target === "dealer") {
    opponent = "dealer";
  } else {
    const uid = parseUserMention(parts[0]);
    if (!uid) return { ok: false, error: "First arg must be @user or 'dealer'" };
    opponent = "user";
    opponentId = uid;
  }

  const gameMap: Record<string, ChallengeParseOk["game"]> = {
    coin: "coin_flip",
    coin_flip: "coin_flip",
    oldmaid: "old_maid",
    old_maid: "old_maid",
    poker: "poker",
    typing: "typing_battle",
    typing_battle: "typing_battle",
  };
  const gRaw = parts[1].toLowerCase();
  const game = gameMap[gRaw];
  if (!game) return { ok: false, error: "Game must be one of: coin, oldmaid, poker, typing" };

  const stake = Number(parts[2]);
  if (!Number.isFinite(stake) || stake <= 0) return { ok: false, error: "Amount must be a positive number" };

  return { ok: true, opponent, opponentId, game, stake };
}

async function resolveUserIdByHandle(client: any, token: string): Promise<string | null> {
    const handle = token.replace(/^@/, "").toLowerCase();
    console.log("Looking for handle:", handle); 
    let cursor: string | undefined;
    
    try {
        do {
            const res = await client.users.list({ limit: 200, cursor });
            const members = (res.members as any[]) ?? [];
            
            console.log(`Checking ${members.length} users...`); 
            
            for (const m of members) {
                if (m.deleted || m.is_bot) continue;
                const uname = (m.name ?? "").toLowerCase();
                const dname = (m.profile?.display_name ?? "").toLowerCase();
                const rname = (m.profile?.real_name ?? "").toLowerCase();
            
                if (uname.includes("qwik") || dname.includes("qwik") || rname.includes("qwik")) {
                    console.log("Found potential match:", { uname, dname, rname, id: m.id });
                }
                
                if (uname === handle || dname === handle || rname === handle) {
                    console.log("Exact match found:", { uname, dname, rname, id: m.id });
                    return m.id as string;
                }
            }
            cursor = res.response_metadata?.next_cursor || undefined;
        } while (cursor);
    } catch (e: any) {
        logger.error("Error resolving user handle", { handle, error: e?.message });
    }
    
    console.log("No user found for handle:", handle);
    return null;
}


async function setPlay(userId: string, on: boolean) {
    await store.update((s) => {
        ensureUserInState(userId);
        s.users[userId].play = on;
        s.users[userId].updatedAt = nowIso();
    });
}

async function setSee(userId: string, on: boolean) {
    await store.update((s) => {
        ensureUserInState(userId);
        s.users[userId].see = on;
        s.users[userId].updatedAt = nowIso();
    });
}

function touchStreak(userId: string) {
    store.update(s => {
        const u = s.users[userId];
        if (!u) return;
        u.stats.currentStreak = (u.stats.currentStreak || 0) + 1;
        u.stats.longestStreak = Math.max(u.stats.longestStreak || 0, u.stats.currentStreak);
        u.updatedAt = new Date().toISOString();
    });
}

function applyWinStreak(userId: string): Promise<void> {
  return store.update(s => {
    const u = s.users[userId];
    if (!u) return;
    u.stats.currentStreak = (u.stats.currentStreak || 0) + 1;
    u.stats.longestStreak = Math.max(u.stats.longestStreak || 0, u.stats.currentStreak);
    u.updatedAt = new Date().toISOString();
  });
}

function applyLossStreak(userId: string): Promise<void> {
  return store.update(s => {
    const u = s.users[userId];
    if (!u) return;
    u.stats.currentStreak = 0;              
    u.updatedAt = new Date().toISOString();
  });
}


export function buildSlackApp() {
    const app = new App({
        token: process.env.SLACK_BOT_TOKEN,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        logLevel: LogLevel.WARN,
    });

    app.command("/ping", async ({ ack, respond }) => {
        await ack();
        await respond({ response_type: "ephemeral", text: "gamble ✅" });
    });

    app.error(async (err: CodedError) => {
        logger.error("Bolt error", {
            code: (err as any)?.code,
            message: err?.message,
            stack: err?.stack,
        });
    });

    app.command("/leaderboard", async ({ ack, respond }) => {
        await ack();
        const s = store.get();
        const rows = Object.values(s.balances || {})
            .map((b: any) => ({ userId: b.userId, amount: b.amount }))
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 10);
        
        if (!rows.length) {
            await respond({ response_type: "ephemeral", text: "No balances yet." });
            return;
        }
            
        const lines = rows.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.amount}`);
        await respond({ response_type: "ephemeral", text: "*Top 10 by coins:*\n" + lines.join("\n") });
    })

    //add special emoji reaction
    app.event("reaction_added", async ({ event, client, logger: boltLogger }) => {
        const ev: any = event;
        try {
            if (ev.reaction !== "siege-coin") return; //change based on reaction name i forgor name
            const userId: string = ev.user;
            if (!userId || userId === "USLACKBOT") return;

            await setPlay(userId, true);
            logger.info("Opt-in (PLAY) via :siege-coin: reaction", { userId });

            const channelId: string | undefined = ev.item?.channel;
            if (channelId) {
                await client.chat.postEphemeral({
                    channel: channelId,
                    user: userId,
                    text: "Welcome to the gamblers. You can now use commands! Toggle the activity feed with `/see on` or `/see off`. Opt out anytime with `/stopgambling`.",
                });
            }
        } catch (e: any) {
            boltLogger.error(e);
        }
    });

    app.command("/challenge", async ({ ack, respond, command, client, logger }) => {
        await ack();
        const userId = command.user_id;
        const channelId = command.channel_id;

        const s = store.get();
        if (!s.users[userId]?.play) {
            await respond({ response_type: "ephemeral", text: "You must opt in first. React with :siege-coin: to opt in. "});
            return;
        }

        const can = canStartBet(userId);
        if(!can.ok) {
            await respond({ response_type: "ephemeral", text: can.reason! });
            return;
        }

        await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "Choose someone to challenge",
            blocks: [
                {
                    type: "section",
                    block_id: "pick",
                    text: { type: "mrkdwn", text: "Choose someone to challenge:" },
                    accessory: {
                        type: "users_select",
                        action_id: "opponent",
                        placeholder: { type: "plain_text", text: "Default: an opponent" }
                    }
                },
                {
                    type: "actions",
                    elements: [
                    { type: "button", text: { type: "plain_text", text: ":x: Cancel" }, value: "cancel", action_id: "challenge_cancel" },
                    { type: "button", text: { type: "plain_text", text: ":white_check_mark: Go!" }, value: "confirm", action_id: "challenge_confirm" }
                    ]
                }
            ]
        });
    });

    app.action("opponent", async ({ ack }) => { await ack(); });

    app.action("challenge_cancel", async ({ ack, respond }) => {
        await ack();
        await respond({ delete_original: true });
    });

    app.action("challenge_confirm", async ({ ack, body, client, respond }) => {
        await ack();

        const userId = (body as any).user?.id as string | undefined;
        const channelId = (body as any).channel?.id as string | undefined;
        if (!userId || !channelId) return;

        const vals = (body as any).state?.values;

        const opponentId = vals?.pick?.opponent?.selected_user as string | undefined;

        if (!opponentId) {
            await respond({
            response_type: "ephemeral",
            text: "Pick an opponent.",
            });
            return;
        }

        if (opponentId === userId) {
            await respond({
            response_type: "ephemeral",
            text: "You can’t challenge yourself. Pick someone else or use a dealer mode.",
            });
            return;
        }

        const key = `${userId}:${channelId}:challenge_confirm`;
        if (onCooldown(key)) {
            await respond({
            response_type: "ephemeral",
            text: "Please wait a moment before sending another challenge.",
            });
            return;
        }

        const can = canStartBet(userId);
        if (!can.ok) {
            await respond({ response_type: "ephemeral", text: can.reason! });
            return;
        }

        const game: "coin_flip" = "coin_flip";
        const stake = 5;

        const rec = await createChallengeRecord({
            channel: channelId,
            challengerId: userId,
            opponent: { kind: "user", id: opponentId },
            game,
            stake,
        });

        const textHead = `<@${userId}> challenged <@${opponentId}> to *coin flip* for *${stake}* coins.`;

        const post = await client.chat.postMessage({
            channel: channelId,
            text: textHead,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: textHead } }],
        });
        await setChallengeRootMessage(rec.id, channelId, (post as any).ts);

        await client.chat.postEphemeral({
            channel: channelId,
            user: opponentId,
            text: `You were challenged by <@${userId}> to *coin flip* for *${stake}* coins. Accept or decline below.`,
            blocks: [
            { type: "section", text: { type: "mrkdwn", text: textHead } },
            {
                type: "actions",
                elements: [
                { type: "button", text: { type: "plain_text", text: "Accept" }, style: "primary", action_id: "challenge_accept", value: rec.id },
                { type: "button", text: { type: "plain_text", text: "Decline" }, style: "danger", action_id: "challenge_decline", value: rec.id }
                ]
            }
            ],
    });

    await respond({ delete_original: true });
    });


    app.command("/stopgambling", async ({ ack, respond, command }) => {
        await ack();
        const userId = command.user_id;
        await store.update((s) => {
            ensureUserInState(userId);
            s.users[userId].play = false;
            s.users[userId].see = false;
            s.users[userId].updatedAt = nowIso();
        });

        await respond ({
            response_type: "ephemeral",
            text: "🛑 You’re opted out. The bot won’t react to you or show you game activity. Re-opt-in by reacting with :siege-coin: on any post."  
        });
    });

    app.command("/coin", async ({ ack, respond, command}) => {
        await ack();
        const userId = command.user_id;

        const s = store.get();
        if (!s.users[userId]) {
            await store.update((st) => {
                st.users[userId] = {
                    id: userId,
                    play: false,
                    see: false,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    stats: { currentStreak: 0, longestStreak: 0},
                };
            });
        }

        const balance = getBalance(userId);
        const u = store.get().users[userId];

        await respond({
            response_type: "ephemeral",
            blocks: [
                {
                    type: "section",
                    text: { type: "mrkdwn", text: `*Your coins:* \`${balance}\`` }
                },
                {
                    type: "context",
                    elements: [
                        { type: "mrkdwn", text: `PLAY: *${u.play ? "on" : "off"}* • SEE: *${u.see ? "on" : "off"}*` },
                        { type: "mrkdwn", text: `Streak: *${u.stats.currentStreak}* (best *${u.stats.longestStreak}*)` }
                    ]
                }
            ]
        });
    });

    app.command("/see", async ({ ack, respond, command }) => {
        await ack();
        const arg = (command.text || "").trim().toLowerCase();

        if (arg !== "on" && arg !== "off") {
            await respond({ response_type: "ephemeral", text: "Usage: `/see on` or `/see off`" });
            return;
        }

        await setSee(command.user_id, arg === "on");
        await respond({ response_type: "ephemeral", text: `SEE is now *${arg}*.` });
    });


    app.message(/\bcoin\b/i, async ({ message, client }) => {
        const m: any = message;
        const userId = m.user as string | undefined;
        if (!userId || userId === "USLACKBOT") return;
        if (!isPlay(userId)) return;
        if (m.subtype) return;

        const { channel, ts } = getMessageSurfaceIds(m);
        if(!channel || !ts) return;

        const key = `${userId}:${channel}:coin`;
        if (onCooldown(key)) return;

        await safeAddReaction(client, channel, ts, "siege-coin");
    });


    app.message(/\b(?:gamble|gambling)\b/i, async ({ message, client }) => {
        const m: any = message;
        const userId = m.user as string | undefined;
        if (!userId || userId === "USLACKBOT") return;
        if (!isPlay(userId)) return;
        if (m.subtype) return;

        const { channel, ts } = getMessageSurfaceIds(m);
        if (!channel || !ts) return;

        const key = `${userId}:${channel}:gamble`;
        if (onCooldown(key)) return;

        await safeAddReaction(client, channel, ts, "game_die", "slot_machine");

        if (isChannelLike(channel)) {
            try {
            await client.chat.postEphemeral({
                channel,
                user: userId,
                text: "let's go *GAMBLING*! 🎲",
            });
            } catch {}
        }
    });

    app.message(/\bwin(ned)?\b|\bwon\b/i, async ({ message, client}) => {
        const m: any = message;
        const userId = m.user as string | undefined;
        if (!userId || userId === "USLACKBOT") return;
        if (!isPlay(userId)) return;
        if (m.subtype) return;

        const { channel, ts } = getMessageSurfaceIds(m);
        if (!channel || !ts) return;

        const key = `${userId}:${channel}:win`;
        if (onCooldown(key)) return;

        await safeAddReaction(client, channel, ts, "heidi_happy", "tada")
    });

    app.message(/\blose\b|\blost\b/i, async ({ message, client }) => {
        const m: any = message;
        const userId = m.user as string | undefined;
        if (!userId || userId === "USLACKBOT") return;
        if (!isPlay(userId)) return;
        if (m.subtype) return;

        const { channel, ts } = getMessageSurfaceIds(m);
        if (!channel || !ts) return;

        const key = `${userId}:${channel}:lose`;
        if (onCooldown(key)) return;

        await safeAddReaction(client, channel, ts, "orpheus_sad", "cry");
    });

    app.view("challenge_modal", async ({ ack, body, view, client, logger }) => {
        await ack();

        try {
            const meta = JSON.parse(view.private_metadata || "{}");
            const channelId = meta.channelId as string | undefined;
            const challengerId = body.user.id as string;

            const opponentId = view.state.values?.op?.opponent?.selected_user as string | undefined;
            if (!opponentId) {
                if (channelId) {
                    await client.chat.postEphemeral({ channel: channelId, user: challengerId, text: "Pick an opponent." });
                } else {
                    const im = await client.conversations.open({ users: challengerId });
                    await client.chat.postMessage({ channel: im.channel!.id!, text: "Pick an opponent." });
                }
            return;
            }

            if (opponentId === challengerId) {
                if (channelId) {
                    await client.chat.postEphemeral({
                    channel: channelId,
                    user: challengerId,
                    text: "You can’t challenge yourself. Pick someone else or use a dealer mode.",
                    });
                }
                return;
            }


            const game = (view.state.values?.gm?.game?.selected_option?.value ?? "coin_flip") as
                "coin_flip" | "old_maid" | "poker" | "typing_battle";
            const stakeRaw = (view.state.values?.st?.stake?.value ?? "").trim();
            const stake = Number(stakeRaw);


            if (!Number.isFinite(stake) || stake <= 0) {
            if (channelId) {
                await client.chat.postEphemeral({
                channel: channelId,
                user: challengerId,
                text: "Stake must be a positive number."
                });
            }
            return;
            }

            if (!channelId) {
            const im = await client.conversations.open({ users: challengerId });
            await client.chat.postMessage({
                channel: im.channel!.id!,
                text: "Couldn’t find the original channel to post in."
            });
            return;
            }

            const rec = await createChallengeRecord({
            channel: channelId,
            challengerId,
            opponent: { kind: "user", id: opponentId },
            game,
            stake
            });

            const textHead =
            `<@${challengerId}> challenged <@${opponentId}> to *${game.replace("_"," ")}* for *${stake}* coins.`;

            const post = await client.chat.postMessage({
            channel: channelId,
            text: textHead,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: textHead } }]
            });
            await setChallengeRootMessage(rec.id, channelId, (post as any).ts);

            await client.chat.postEphemeral({
                channel: channelId,
                user: opponentId,
                text: `You were challenged by <@${challengerId}> to *${game.replace("_"," ")}* for *${stake}* coins. Accept or decline below.`,
                blocks: [
                    { type: "section", text: { type: "mrkdwn", text: textHead } },
                    {
                    type: "actions",
                    elements: [
                        { type: "button", text: { type: "plain_text", text: "Accept" }, style: "primary", action_id: "challenge_accept", value: rec.id },
                        { type: "button", text: { type: "plain_text", text: "Decline" }, style: "danger", action_id: "challenge_decline", value: rec.id }
                    ]
                }
                ]
            });

        } catch (e: any) {
            logger.error("challenge_modal_error", { error: e?.message, stack: e?.stack });
        }
    });

    app.action("challenge_accept", async ({ ack, body, client, respond }) => {
        await ack();

        const action = (body as any).actions?.[0];
        const challengeId = action?.value as string | undefined;
        const userId = (body as any).user?.id as string | undefined;
        const channelId = (body as any).channel?.id as string | undefined;
        if (!challengeId || !userId || !channelId) return;

        const rec = getChallenge(challengeId);
        if (!rec) {
            await respond({ replace_original: true, text: "This challenge no longer exists." });
            return;
        }
        if (rec.opponent.kind !== "user" || rec.opponent.id !== userId) {
            await respond({ replace_original: true, text: "Only the challenged user can accept." });
            return;
        }

        if (rec.state !== "pending") {
            await respond({ replace_original: true, text: `This challenge is already ${rec.state}.` });
            return;
        }

        if (!store.get().users[userId]?.play) {
            await respond({ replace_original: false, text: "Opt in first: react with :siege-coin: then tap Accept again." });
            return;
        }

        const res = await acceptChallengeAndLockStake(challengeId, userId);
        if (!res.ok) {
            await respond({ replace_original: false, text: `Could not accept: ${res.reason}` });
            return;
        }

        await respond({ replace_original: true, text: "✅ Accepted. Stakes locked. Game starting…" });

        const ts = getChallenge(challengeId)?.rootTs;
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `✅ <@${userId}> accepted. Stakes locked.` });
        if (ts) {
            await client.chat.update({
            channel: channelId,
            ts,
            text: `Challenge accepted.`,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Challenge accepted.*` } }],
            });
        }

        await runCoinFlip(client, challengeId);
    });


    app.action("challenge_decline", async ({ ack, body, client, respond }) => {
        await ack();

        const action = (body as any).actions?.[0];
        const challengeId = action?.value as string | undefined;
        const userId = (body as any).user?.id as string | undefined;
        const channelId = (body as any).channel?.id as string | undefined;
        if (!challengeId || !userId || !channelId) return;

        const rec = getChallenge(challengeId);
        if (!rec) {
            await respond({ replace_original: true, text: "This challenge no longer exists." });
            return;
        }
        if (rec.opponent.kind !== "user" || rec.opponent.id !== userId) {
            await respond({ replace_original: true, text: "Only the challenged user can decline." });
            return;
        }

        if (rec.state !== "pending") {
            await respond({ replace_original: true, text: `This challenge is already ${rec.state}.` });
            return;
        }

        await declineChallenge(challengeId, userId);
        await refundStakes(challengeId);

        await respond({ replace_original: true, text: "❌ Declined." });

        const ts = rec.rootTs;
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `❌ <@${userId}> declined the challenge.` });
        if (ts) {
            await client.chat.update({
            channel: channelId,
            ts,
            text: `Challenge declined.`,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Challenge declined.*` } }],
            });
        }
    });

    app.command("/shop", async ({ ack, respond }) => {
        await ack();
        await respond({
            response_type: "ephemeral",
            text: [
            "*Shop*",
            "• Streak Saver — 50",
            "• Sigma (keep coins through weekly reset) — 5000",
            "",
            "Buy with `/buy saver` or `/buy sigma`"
            ].join("\n")
        });
        });

        app.command("/buy", async ({ ack, respond, command }) => {
        await ack();
        const userId = command.user_id;
        const item = (command.text || "").trim().toLowerCase();
        const price = item === "saver" ? 50 : item === "sigma" ? 5000 : null;
        if (!price) { await respond({ response_type: "ephemeral", text: "Usage: `/buy saver` or `/buy sigma`" }); return; }

        const bal = getBalance(userId);
        if (bal < price) { await respond({ response_type: "ephemeral", text: "Not enough coins." }); return; }

        try {
            await addTransaction(userId, "purchase", -price, { refId: `shop:${item}`, idemKey: `shop:${item}:${userId}:${Date.now()}` });
            await store.update(s => {
            (s as any).inventory = (s as any).inventory || {};
            (s as any).inventory[userId] = (s as any).inventory[userId] || {};
            (s as any).inventory[userId][item] = ((s as any).inventory[userId][item] || 0) + 1;
            });
            await respond({ response_type: "ephemeral", text: `Purchased *${item}*.` });
        } catch {
            await respond({ response_type: "ephemeral", text: "Could not complete purchase." });
        }
    });

    app.message(/rickroll/i, async ({ message, client }) => {
        const m: any = message;
        const userId = m.user as string | undefined;
        if (!userId || userId === "USLACKBOT") return;
        if (!isPlay(userId)) return;
        if (m.subtype) return;

        const { channel, ts } = getMessageSurfaceIds(m);
        if (!channel || !ts) return;

        await client.chat.postMessage({
            channel,
            thread_ts: m.thread_ts || ts,
            text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        });
    });

    app.message(/\b(i['’]?m|im)\s+poor\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:poor`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "hard-same");
    });

    app.message(/\bdrama\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:drama`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "cat-chips");
    });

    app.message(/\bi\s+lost\s+it\s+all\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:lostitall`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "noooovanish");
    });

    app.message(/\bunders?tand\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:understand`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "yesyes");
    });

    app.message(/\bvibe\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:vibe`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "blob_bounce");
    });

    app.message(/\bawesome\b/i, async ({ message, client }) => {
        const m: any = message; const uid = m.user as string | undefined;
        if (!uid || uid === "USLACKBOT") return;
        if (!isPlay(uid) || m.subtype) return;
        const { channel, ts } = getMessageSurfaceIds(m); if (!channel || !ts) return;
        const key = `${uid}:${channel}:awesome`; if (onCooldown(key)) return;
        await safeAddReaction(client, channel, ts, "cooll-thumbs");
    });


    //because socket is being stupid
    app.event("app_mention", async ({event, say, client}) => {
        const ev = event as any;
        const text = String((event as any).text || "").toLowerCase();

        if (/help/i.test(text)) {
            await client.chat.postMessage({
                channel: ev.channel,
                text: "Hi! Opt in with :siege-coin:. Toggle feed with `/see on|off`. Opt out with `/stopgambling`.",
                thread_ts: ev.thread_ts || ev.ts,
            });
            return;
        }

        if (/\bhello\b/i.test(text) || /\bhi\b/i.test(text)) {
            await client.chat.postMessage({
            channel: ev.channel,
            text: `hello <@${ev.user}>, start gambling RIGHT NOW!`,
            });
            return;
        }

        await client.chat.postMessage({
            channel: ev.channel,
            text: "What? WHY ARE YOU NOT GAMBLING",
            thread_ts: ev.thread_ts || ev.ts,
        });
    });

    const GAMBLE_MODAL_ID = "gamble_modal";

    app.command("/gamble", async ({ ack, command, respond, client }) => {
        await ack();

        const userId = command.user_id;
        if (!isPlay(userId)) {
            await respond({
            response_type: "ephemeral",
            text: "You must opt in first. React with :siege-coin: to opt in.",
            });
            return;
        }

        await client.views.open({
            trigger_id: command.trigger_id,
            view: {
            type: "modal",
            callback_id: GAMBLE_MODAL_ID,
            private_metadata: JSON.stringify({ channelId: command.channel_id }),
            title: { type: "plain_text", text: "Gamble" },
            submit: { type: "plain_text", text: "Flip" },
            close: { type: "plain_text", text: "Cancel" },
            blocks: [
                {
                type: "input",
                block_id: "amt",
                label: { type: "plain_text", text: "How many coins?" },
                element: {
                    type: "plain_text_input",
                    action_id: "amount",
                    placeholder: { type: "plain_text", text: "e.g., 5" },
                },
                },
            ],
            },
        });
        });

        app.view(GAMBLE_MODAL_ID, async ({ ack, body, view, client }) => {
        const userId = body.user.id as string;
        const meta = JSON.parse(view.private_metadata || "{}") as { channelId?: string };
        const channelId = meta.channelId as string | undefined;

        const raw = view.state.values?.amt?.amount?.value ?? "";
        const amount = Number(raw);

        if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
            await ack({
            response_action: "errors",
            errors: { amt: "Enter a positive whole number." },
            });
            return;
        }

        const balance = getBalance(userId);
        if (amount > balance) {
            await ack({
            response_action: "errors",
            errors: { amt: "That is not allowed (amount exceeds your balance)." },
            });
            return;
        }

        await ack();

        const ref = `self:${view.id}`;
        try {
            await addTransaction(userId, "bet", -amount, {
            refId: ref,
            idemKey: `${ref}:bet`,
            });
        } catch {
            
        }

        const coinSide = Math.random() < 0.5 ? "Heads" : "Tails";
        const didWin = Math.random() < 0.5;

        if (didWin) {
            try {
            await addTransaction(userId, "win", amount * 2, {
                refId: ref,
                idemKey: `${ref}:payout`,
            });
            await applyWinStreak(userId);
            } catch {}
        } else {
            await applyLossStreak(userId)
        }

        const newBal = getBalance(userId);
        const text = didWin
            ? `🪙 Flipped *${coinSide}* — You *WIN* +${amount} (net). New balance: \`${newBal}\`.`
            : `🪙 Flipped *${coinSide}* — You *lose* -${amount}. New balance: \`${newBal}\`.`;

        try {
            if (channelId) {
            await client.chat.postEphemeral({ channel: channelId, user: userId, text });
            } else {
            const im = await client.conversations.open({ users: userId });
            await client.chat.postMessage({ channel: im.channel!.id!, text });
            }
        } catch {
            try {
            const im = await client.conversations.open({ users: userId });
            await client.chat.postMessage({ channel: im.channel!.id!, text });
            } catch {}
        }
    });


    app.command("/listusers", async ({ ack, respond, client }) => {
        await ack();
        
        try {
            const res = await client.users.list({ limit: 20 });
            const members = (res.members as any[]) ?? [];
            const userList = members
                .filter(m => !m.deleted && !m.is_bot)
                .map(m => `${m.name} (${m.profile?.display_name || 'no display name'})`)
                .slice(0, 10)
                .join('\n');
                
            await respond({
                response_type: "ephemeral",
                text: `First 10 users:\n${userList}`
            });
        } catch (e) {
            await respond({
                response_type: "ephemeral", 
                text: "Error fetching users"
            });
        }
    });
    return app;
}

export async function startSlackApp(app: ReturnType<typeof buildSlackApp>) {
    await fs.mkdir(CONFIG.dataDir, { recursive: true });
    
    const port = Number(process.env.PORT) || 3000;
    await app.start({ port });
    logger.info("Slack app runnin (SOCKET)", { port });

    scheduleJobs(app);
}
