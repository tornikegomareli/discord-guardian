<h1 align="center">Discord Guardian</h1>

<h3 align="center">A calm moderator for your Discord, run by your Grok Bot.</h3>

```
 Discord ──► discord-guardian (pm2) ──► webhook ──► Grok Bot ──► npm run cmd ──► Discord
              spam filter, flags          Bearer key    decides      reply · delete · timeout
```

Discord Guardian is an AI moderator and FAQ helper for one Discord server. The Discord process makes no AI calls. It filters obvious spam locally, forwards mentions and flagged messages to a [Grok Bot](https://grok.com) webhook routine, and the Grok Bot acts through a small local CLI. Kicks and bans only happen when a human staff member presses Approve.

Based on [ModAgent](https://github.com/rollsro9/mod-agent-for-discord-) by Lorenzo Galati.

## Spam never waits for a human

Every message runs through a case-insensitive regex pre-filter: invite links, nitro scams, account selling, `@everyone`, more than five user mentions. A hit posts a flag with Approve buttons in your private staff channel right away, then sends a `flag` event to the Grok Bot. Staff see it even if the webhook is down.

The Grok Bot is told how to handle each case:

| Situation | Action |
| --- | --- |
| Obvious spam or scam | `delete` + `timeout minutes=60`, logged in the staff channel |
| Uncertain | `flag-for-approval`, then staff press Approve or Reject |
| Ban-worthy or ambiguous | the Grok Bot tells the owner in its own chat; a human presses Approve: ban |
| Member question | `reply` from the FAQ only; otherwise it stays silent |

## Answers from your FAQ, nothing else

@mention the bot or reply to it and the message goes to the Grok Bot as a `mention` event with the last few messages as context. While it thinks, Discord shows "Guardian is typing…". It answers only from the FAQ in `config.yaml` and never pings `@everyone`, roles or users (except the person it replies to).

Webhook calls are rationed: 60 seconds per user per event type, 20 seconds per channel for mentions, 200 events per UTC day. A failed send is written to `data/failed-events.jsonl` and is not retried.

## Kicks and bans stay human

There is no kick or ban command. Those exist only as **Approve: kick** and **Approve: ban** buttons in the staff channel, and only members with Moderate Members (or a role in `approver_role_ids`) can press them. Role hierarchy is checked for both the approver and the bot, and the server owner is never actioned. The command API listens on `127.0.0.1` only and needs the `X-Guardian-Secret` header.

## Install

```sh
git clone https://github.com/tornikegomareli/discord-guardian.git
cd discord-guardian
npm install
cp .env.example .env && chmod 600 .env       # fill in secrets, see Settings
cp config.example.yaml config.yaml           # channel IDs and FAQ
npm run build
mkdir -p data/logs
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup                                  # run the command it prints, to start on boot
npm run cmd -- health                        # → 200 {"ok":true,"user":"YourBot#1234"}
```

Requirements:

- Node.js 20 or newer, npm, git and [pm2](https://pm2.keymetrics.io/) (`npm i -g pm2`)
- A Discord application with a bot user
- A Grok Bot with a webhook routine, which gives you a URL and a sender key
- The Discord process and the Grok Bot on the same computer, because the CLI talks to `127.0.0.1`

### The Discord app

1. In the [Developer Portal](https://discord.com/developers/applications), create a **New Application** and open **Bot**.
2. Turn on **Message Content Intent** and **Server Members Intent**.
3. **Reset Token** and put it in `.env` as `DISCORD_TOKEN`. Never paste it in a chat.
4. Invite it with least privilege (View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Moderate Members, Kick Members, Ban Members):

   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1099511720966
   ```

   Kick and Ban are only used after a human presses Approve. Use `permissions=1099511720960` if you never want the bot to kick or ban.
5. In Server Settings → Roles, drag the bot's role above every role it may need to time out. Discord refuses actions on members whose top role is equal or higher.

To keep it up on computers without a boot hook, have a Grok Bot routine run `pm2 resurrect` and `npm run cmd -- health` every 30 minutes.

## Remove

```sh
pm2 delete discord-guardian && pm2 save
rm -rf discord-guardian
```

Then remove the bot from your server (Server Settings → Integrations), delete the webhook routine in your Grok Bot, and delete the application in the Developer Portal if you no longer need it.

## Using it

The Grok Bot drives everything with `npm run cmd -- <command> key=value …`:

```sh
npm run cmd -- health
npm run cmd -- reply             channel_id=… content="…" [message_id=…]
npm run cmd -- delete            channel_id=… message_id=… [reason="…"]
npm run cmd -- timeout           channel_id=… user_id=… [minutes=10] [reason="…"] [message_id=…]
npm run cmd -- flag-for-approval channel_id=… message_id=… reason="…"
```

Output is `<HTTP status> <JSON>`, and the exit code is 0 on success. `timeout` defaults to 10 minutes and is clamped to 1–`max_timeout_minutes`.

Each event arrives as a `POST` to the webhook URL with `Authorization: Bearer <key>`:

```json
{
  "type": "mention",
  "guild_id": "…", "channel_id": "…", "channel_name": "general",
  "message_id": "…", "message_url": "https://discord.com/channels/…",
  "author_id": "…", "author_name": "user#0",
  "content": "first 1500 chars",
  "context": "last N messages, oldest first",
  "prefilter_reason": null,
  "sent_at": "2026-01-01T12:00:00.000Z"
}
```

`type` is `mention` or `flag`; for a flag, `prefilter_reason` names the match, such as `pattern: free\\s+nitro`.

## Settings

Secrets live in `.env`, which is gitignored:

| Key | Required | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `GUARDIAN_WEBHOOK_URL` | yes (grokbot) | Webhook URL from the Grok Bot routine panel |
| `GUARDIAN_WEBHOOK_KEY` | yes (grokbot) | Sender key from the routine panel |
| `GUARDIAN_LOCAL_SECRET` | yes (grokbot) | 16+ random chars, shared by the bot and `npm run cmd`. Make one with `openssl rand -hex 24` |
| `GUARDIAN_LOCAL_PORT` | no | CLI port, default `8787`. Must match `grokbot.local_port` |
| `LLM_API_KEY` / `ANTHROPIC_API_KEY` | no | Only for the optional `openai` / `anthropic` providers |

Everything else is in `config.yaml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `server.mod_channel_id` | required | Private staff channel: flags, Approve buttons, daily stats. The bot ignores messages there |
| `server.general_channel_ids` | `[]` | Answer channels, also checked for permissions at startup |
| `server.welcome_channel_id` | `""` | Unused in grokbot mode |
| `llm.provider` | `grokbot` | `grokbot` means no AI calls; use the webhook |
| `moderation.prefilter_patterns` | invite links, nitro scams, … | Case-insensitive regexes |
| `moderation.max_mentions` | `5` | More user mentions than this is a flag |
| `moderation.mode` | `approve` | `recommend` flags without buttons; `approve` adds buttons |
| `moderation.timeout_minutes` | `60` | Length of a timeout from the **Approve: timeout** button |
| `moderation.ban_delete_message_seconds` | `3600` | Message history removed on an approved ban |
| `moderation.mod_log_channel_id` | `""` | Where action results are logged; empty means the mod channel |
| `moderation.approver_role_ids` | `[]` | Who may press Approve; empty means anyone with Moderate Members |
| `grokbot.auth_header` | `Authorization` | Sends `Authorization: Bearer <key>` |
| `grokbot.timeout_ms` | `8000` | One try, no retry |
| `grokbot.user_cooldown_seconds` | `60` | Per user, per event type |
| `grokbot.channel_cooldown_seconds` | `20` | Mentions only |
| `grokbot.daily_event_cap` | `200` | Max webhook POSTs per UTC day |
| `grokbot.context_messages` / `context_max_chars` | `6` / `1500` | Recent messages sent as context |
| `grokbot.failed_log` | `data/failed-events.jsonl` | Events that failed to send |
| `grokbot.typing_max_seconds` | `90` | How long "Guardian is typing…" can show |
| `grokbot.local_port` | `8787` | CLI API, bound to 127.0.0.1 |
| `grokbot.max_timeout_minutes` | `1440` | Ceiling for CLI timeouts |
| `interactions.respond_to_mentions` | `true` | Forward @mentions and replies to the bot |
| `interactions.persona` / `interactions.faq` | — | Persona and FAQ the Grok Bot answers from |
| `digest.enabled` / `post_hour_utc` | `true` / `21` | Daily stats in the mod channel |

The `news`, `movies`, `proactive`, `reactions`, `budget`, `memory` and `llm.models` sections are only used with the optional `openai` and `anthropic` providers.

### When something breaks

| Symptom | Fix |
| --- | --- |
| `[bridge] webhook HTTP 401` in `data/logs/err.log` | The routine's key is wrong or the routine was recreated. Recreate the webhook routine, re-enter both URL and key in `.env`, then `pm2 restart discord-guardian --update-env` |
| Events in `data/failed-events.jsonl` | The webhook was down; the routine can process them later |
| `npm run cmd` → `401 unauthorized` | `GUARDIAN_LOCAL_SECRET` differs between bot and shell; restart with `--update-env` |
| `fetch failed` / `ECONNREFUSED` from `npm run cmd` | The bot is not running: `pm2 resurrect` or `pm2 start ecosystem.config.cjs` |
| `Used disallowed intents` | Turn on Message Content and Server Members intents in the portal |
| `mod_channel_id does not point to a text channel` | Wrong ID, or the bot cannot see that channel |
| `Blocked: target's top role is not below …` | Move the bot role higher in Server Settings → Roles |
| `[PermsCheck] … missing permissions` | Give the bot View Channel and Send Messages there |

## Development

```sh
npm run dev        # tsx watch
npm run typecheck
npm test
```

After code changes, run `npm run build && pm2 restart discord-guardian`.

## License

[MIT License](LICENSE). Originally [ModAgent](https://github.com/rollsro9/mod-agent-for-discord-) by Lorenzo Galati.
