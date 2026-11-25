# Planner — journal, AI notes, planning and reminders

A journal you can write in from your phone or laptop. Everything syncs between them. It works offline too: entries you write without signal are saved on the device and sent when you're back online.

## Google Calendar, Apple Calendar, Outlook

Settings → Calendar apps → **Create my calendar link**. It's a private link (`https://…/cal/<secret>.ics`) that calendar apps can subscribe to. Your planned sessions (with an alert before each, using your reminder setting), finished sessions (marked ✓) and deadlines (all-day) show up there and stay updated. It works one way: you still plan in Planner.

- **Google Calendar:** on a computer, open calendar.google.com → "Other calendars" **+** → **From URL** → paste the link. It then appears in the phone app too. Google checks for changes every few hours.
- **Apple Calendar:** on iPhone, tap "Open in calendar app" in Planner, or Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar. On Mac: File → New Calendar Subscription, with Auto-refresh every 15 minutes.
- **Outlook:** Calendar → Add calendar → Subscribe from web.
- **Apple Reminders** can't subscribe to links. Use the calendar alerts or Planner's notifications.
- "Make a new link" stops the old one working (if you shared it by mistake). "Turn off" removes it.

## Things for today with no time yet

If something is due today (or overdue) and has no session yet, like "do CTME experiment":
- **Today** shows a "For today, no time yet" card with a suggested free slot (**Plan at 16:00**), a time box to pick your own, and **Not today**.
- **A morning notification** (08:00 by default, Settings → Notifications → Morning to-do check) says the same, with **Plan at 16:00** / **Pick a time** buttons, or **Plan them all** when there are several. Suggestions respect your hours, busy times, days off and rules.

## Private journal

Settings → Private journal → Turn on. Your journal entries and the AI's notes about them get encrypted on your device before they're uploaded. The database only holds unreadable text, so not even the person who runs the app can read them.

- **Passphrase:** each device asks for it once, then stays unlocked (until you log out).
- **Recovery code:** shown once at setup, and you must save it (copy or download) before private mode turns on. If you forget your passphrase, type the code on the Journal tab, then set a new passphrase.
- **If you forget both:** any device that's still unlocked can set a new passphrase or make a new recovery code without the old ones.
- **AI still works:** each new entry is sent for that one reading; nothing readable is stored.
- **Not encrypted:** tasks, plans and settings, so reminders can show task names.
- **Turning it off** decrypts everything and uploads it as normal text again. Nothing is lost.
- On each device, the readable copy stays in that browser's storage, like any notes app. Your phone's screen lock protects it.

## Repeating tasks

Open a task in Plan and pick the days it repeats ("every day", "weekdays" or your own days) and, optionally, a usual time. "Make my plan" then puts one session on each of those days, at the usual time when it's free, before fitting in your other tasks. Finishing a session doesn't end the task; "Stop repeating" does.

## From journal to plan in one tap

Tap ✓ on a "Plan: …" note under a journal entry and it becomes a task immediately. Turn on "When I confirm a plan from my journal, put it in my schedule straight away" in Settings → My week, and it also gets a time slot (on the day you mentioned, if any). Every step has Undo.

## Weekly review

The Log tab opens with your week in review: time done, how much of the plan that was, sessions done/skipped/without an update, the reasons you gave for skipping, your best day, how long sessions took compared with the plan, and one plain suggestion for next week. On Sundays a notification brings you there (an hour before your evening check-in, or at 19:00). Switch it off in Settings → Notifications.

## Shortcuts and sharing (Android)

- Long-press the Planner icon for: New journal entry, Quick add task, Today, Calendar.
- In any app, tap Share → Planner to save the text or link as a journal entry or a task.

Android picks these up when it next refreshes the installed app, which can take a day. To get them right away, remove Planner from the home screen and install it again from Chrome (your data stays; it's on the server).

## Getting started

New accounts see a checklist on Today: set your week, turn on notifications, choose an AI, write a first entry, make a first plan. Tap a step to jump there. It disappears when everything's done, or tap Hide.

## Calendar

The **Calendar** tab shows a month at a glance:
- **Shading:** how much you worked that day (darker = more), from finished sessions or time noted in your journal.
- **Thin bar:** how much of the planned time got done.
- **Dots:** amber = you wrote in the journal, red diamond = a deadline, hollow circle = sessions planned.

Tap any day to see its sessions (done, skipped with the reason, or no update), deadlines and journal entries (tap an entry to read it all). Use ‹ › or swipe to change months. On today and future days you can **add a session** (for an existing or a new task), **move** one (✎) or **remove** one (✕, with Undo).

## AI services: which model to type

- **Google Gemini:** `gemini-3.6-flash` or `gemini-3.8-flash` (or `gemini-3.5-flash-lite` for the cheapest). Older `gemini-2.0` and `1.5` names no longer work.
- **Free built-in:** leave Model empty. It uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Cloudflare retired the older Llama 3.1 models in May 2026.

If the AI service is busy, the app tries again a few times on its own, and journal entries wait and get read later.

## Step 4: notifications

Settings → Notifications → **Turn on for this device**. Do it on each device you want reminders on (phone, laptop). **Send a test** checks it works.

What you get, in your own time zone:
- **Before each planned session** (10 min by default; at the start, 5, 15 or 30 min before, or off). The notification has a **Start timer** button.
- **Evening check-in** (21:00 by default, or off). It asks about one missing thing, the most useful first: sessions with no update, then journal notes waiting for a ✓, then a line for the journal. If nothing's missing, it stays quiet. At most one a day.
- **Morning summary** of today's plan (off by default). Set a time to turn it on.

Tapping a notification opens the right screen. Nothing is ever sent twice.

On iPhone, notifications only work after adding the app to the Home Screen (Share → Add to Home Screen) and opening it from there (iOS 16.4 or newer).

**One-time setup for notifications** (in the planner folder, in PowerShell):
1. Make the notification key and copy the line it prints:
   ```
   npm run vapid
   ```
2. Save it as a secret (paste the line when asked):
   ```
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```
   Keep this key. If you replace it, every device has to turn notifications on again.
3. In `wrangler.toml`, change `VAPID_SUBJECT = "mailto:you@example.com"` to your own email.
4. Update the database and publish:
   ```
   npm run db:remote
   npm run deploy
   ```
   (If GitHub auto-deploy is set up, just push instead of running `npm run deploy`.)

The server checks for reminders every 5 minutes (the `[triggers]` part of `wrangler.toml`), so a reminder can arrive up to 5 minutes later than its time.

## Step 3: planning

The app opens on **Today**. On a phone the tabs sit at the bottom: Today · Journal · Plan · Log · Settings.

**First, tell it your week** (Settings → My week): when you can work, days off, busy times like college, how many focused hours a day, how long one session can be, and the break between sessions.

**Things to know about me now affect plans.** Each line gets read into a rule, shown under it as "Planner: …":
- "I don't like working on Fridays" → avoid Fridays unless a deadline needs it
- "Never work on Sundays" → no work on Sundays, ever
- "Max 4 hours a day" → daily limit
- "I focus better at night" → evening slots first (needs an AI to read this one)

Tap "Make it a must" / "Make it a preference" to change how strict a rule is, or "Ignore" to leave it out of planning.

**Plan tab:**
- *Quick add*: one line becomes a task (1 h guess, tap it to change).
- *Describe a bigger goal*: the AI may ask up to 3 questions, then suggests tasks with times. You edit, remove or add before saving. Without an AI, use "Add tasks by hand".
- *From your journal*: plans you confirmed in the journal ("call the lab tomorrow") show up here, one tap to make them tasks.
- *Make my plan*: fits open tasks into your free time for the next 7 days. Earliest deadline first, then priority. You see the proposal before anything changes. The **daily limit** buttons give you a lighter or harder week. Warnings tell you plainly when something won't fit before its deadline, or when a "rather not" day had to be used.
- Tap a task to edit it, mark it finished or delete it (with undo).

**Today tab:**
- "Next up" with a countdown, or the running timer.
- **Start** runs a timer. It syncs, so you can start on the phone and see it on the laptop.
- **Done** asks how long it really took (filled in from the timer) and whether the whole task is finished. Finishing a task frees its other planned sessions.
- **Skip** asks what got in the way (optional): no time, too tired, something came up, task unclear, didn't feel like it.
- **Later** moves a session to the next free slot.
- Sessions from the last 3 days you never answered show under "Still open from earlier".
- After 8 pm a "Write about today" button takes you to the journal.

Real times and skip reasons are saved now. Step 5 will use them to learn how long things really take you.

**If you're updating from an earlier step,** run `npm run db:remote` once, then `npm run deploy`.

## Step 2: the AI reads your entries

Once you pick an AI in Settings, every new entry gets read. Underneath it you see what was noted:

- **Activities:** what you did, how long it took, whether it got done, and why not if it didn't. If the time is missing, it asks "How long?" with quick buttons.
- **Plans:** things you said you'll do, with the date if you gave one.
- **Things about you:** lasting habits like "I focus better at night". Tap "Add to my list" to put one in Things to know about me.

Tap ✓ if it's right, **Fix** to correct it, or ✕ if it's wrong. Nothing counts until you confirm it, and ↺ undoes a confirmation. Your original entry is never changed.

- If you edit an entry, it gets read again. What you already confirmed is kept, and only the unconfirmed notes are replaced.
- Entries written before you set up an AI aren't read automatically. Each has a **Read with AI** button.
- The **Log** tab shows the last 7 days (time per category; done / partly / not done), upcoming plans, and a day-by-day history.
- Each person can make at most 150 AI calls a day (`AI_DAILY_LIMIT` in `wrangler.toml`), so one friend can't use up your free allowance or run up a bill.

**If you're updating from step 1,** run `npm run db:remote` once, then `npm run deploy`. Your data stays.

## Step 1: what's in it

- Accounts (sign-up needs an invite code, so only people you give it to can join)
- Journal: write, edit, delete (with undo), search, #tags, optional energy (low / okay / high)
- Drafts are kept if you close the app halfway through writing
- Works offline and syncs on its own: when the app opens, when you switch back to it, when the internet returns, and every minute
- Installs like an app on Android, iPhone and Windows
- "Things to know about me" list (e.g. "I don't like working on Fridays"). The planner will use these later.
- AI settings: each person picks their own AI service and key. The key is stored encrypted and never sent back to the browser.
- Download all your data, or delete your account

## One-time setup (about 15 minutes)

You need [Node.js](https://nodejs.org) (the LTS version) and a free Cloudflare account. Run these in PowerShell inside this folder.

1. Install the tools:
   ```
   npm install
   ```
2. Log in to Cloudflare (a browser window opens):
   ```
   npx wrangler login
   ```
3. Create the database:
   ```
   npx wrangler d1 create planner-db
   ```
   It prints a `database_id`. Open `wrangler.toml` and paste it where it says `PASTE-YOUR-DATABASE-ID-HERE`.
4. Create the tables:
   ```
   npm run db:remote
   ```
5. Set the two secrets. Each command asks you to type a value.
   ```
   npx wrangler secret put INVITE_CODE
   npx wrangler secret put KEY_SECRET
   ```
   - INVITE_CODE: any word you'll give to friends.
   - KEY_SECRET: long random text. Get one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`. **Never change it later.** If it changes, everyone's saved AI keys stop working and have to be typed in again.
6. Put it online:
   ```
   npm run deploy
   ```
   It prints your address, something like `https://planner.<your-name>.workers.dev`.
7. Open that address on your laptop, tap "Create account", and use your invite code. Then open it on your phone and log in with the same username and password.
8. Install it. Android (Chrome): menu ⋮ → "Install app" or "Add to Home screen". iPhone (Safari): Share → "Add to Home Screen". Windows (Chrome or Edge): the install icon in the address bar.

To update the app later, run `npm run deploy` again. Your data stays.

## Giving it to friends

Send them the address and the invite code. Each friend gets a separate account, and nobody can see anyone else's journal.

Each friend picks their AI in Settings → AI:
- **Claude:** needs an Anthropic API key.
- **OpenAI-compatible:** one option covers OpenAI, Google Gemini, Groq, OpenRouter and DeepSeek. Pick the provider, paste a key and type the model name. Google Gemini and Groq have offered free tiers, so friends without a paid key can usually start there. Check their current terms.
- **Free built-in:** runs on your Cloudflare account and needs no key. Everyone who picks it shares your account's free daily allowance, so it's best as a backup. To switch it off, delete the `[ai]` lines at the bottom of `wrangler.toml` and deploy again.

"Test connection" tells them straight away whether the key and model work.

## Adding another AI later

All AI calls go through `src/ai.js`. To add a service, add one entry to `PROVIDERS` with a `call()` function that sends the request and returns the reply text. Nothing else in the app needs to change. Your own trained model can plug in the same way later.

## Testing on your own computer

```
copy NUL .dev.vars
```
Then put these two lines in `.dev.vars`:
```
INVITE_CODE=test-invite
KEY_SECRET=local-dev-secret
```
Then:
```
npm run db:local
npm run dev:local
```
Add these to `.dev.vars` too: `AI_DAILY_LIMIT=10` (the tests check the limit), `LOCAL_TESTING=1`, and `VAPID_PRIVATE_JWK='<the line from npm run vapid>'`. Start the local server with `npx wrangler dev -c wrangler.test.toml --test-scheduled` to test reminders.

Open http://localhost:8787. In a second terminal, `npm test` runs 118 checks: the scheduler (29), the AI layer (10), login and sync (21), AI reading of entries (12), planning (13), notifications (18), private journal and repeating tasks (10), calendar link (5). They use a fake AI, so no key is needed.

## How sync works (short version)

- Every entry gets its ID on the device, so an entry written offline keeps its ID when it reaches the server. Sending it twice never creates a copy.
- If you edit the same entry on two devices, the edit saved last wins.
- Deleted entries are synced as "deleted", and the text is wiped on the server.

## Known limits right now

- No lockout after many wrong passwords yet. Use a long password.
- Typing an edit to the *same* entry on two devices at the same moment keeps only the later one.
- Plans cover 7 days ahead. Run "Make my plan" again whenever things change; it only replaces sessions that haven't started.

## Files

| File | What it does |
|---|---|
| `src/worker.js` | The server: login, sync, settings, export, delete |
| `src/ai.js` | The swappable AI layer |
| `src/extract.js` | What the AI is asked when it reads an entry, and the code that checks its answer |
| `src/plan.js` | What the AI is asked for goal breakdowns and preference rules, and the checks on its answers |
| `public/planner-core.js` | The scheduler and rules. Plain code, no AI, used by both the app and the server |
| `public/plan.js` | Today, Plan and My week screens |
| `public/calendar.js` | The Calendar tab |
| `public/vault.js` | Private journal: encryption, unlocking, recovery code |
| `public/extras.js` | Weekly review, getting-started checklist, saving things shared from other apps |
| `public/notify.js` | Notification settings, and opening the right screen from a notification |
| `src/ics.js` | The private calendar link (.ics feed) |
| `src/push.js` | Sending notifications: encryption and signing, no outside library |
| `src/notify.js` | What gets sent and when (reminders, evening check-in, morning summary) |
| `scripts/vapid.mjs` | Makes the notification key |
| `migrations/` | Database tables (0001 = step 1, 0002 = AI notes, 0003 = planning, 0004 = notifications, 0005 = private journal and repeating tasks, 0006 = calendar link) |
| `public/` | The app you see (HTML, CSS, JS, offline support, icons) |
| `test/api.test.mjs` | Automated checks |
