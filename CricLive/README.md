# CricLive – Live Club Cricket Scoring

A website for club cricket. Organisers run tournaments, register teams and players, and schedule fixtures. A scorer records each match **ball by ball**, and every viewer sees the score change **instantly**, with a celebration for every four, six, wicket and win. Player stats, team stats, charts, standings and AI player types update after every ball, and anyone can download match and player data with charts and tips for improving.

Demo data: **6 city clubs** (Leeds Lynx, Manchester Mavericks, Bristol Buccaneers, Nottingham Nomads, Cardiff Comets, Glasgow Griffins), **78 players** and **2 tournaments**. The Club T10 Spring Cup 2026 is complete. The National Club League 2026 has results, a rain-off, a **live match** and upcoming fixtures.

## What's new in version 4

| Area | What you get |
|---|---|
| Celebrations | **FOUR:** sparkles and a boundary ring. **SIX:** the ball flies out of the ground, with fireworks. **WICKET:** the stumps shatter and the bails fly, with a red flash. **WIN:** a trophy with confetti in the winners' colours. **Milestones:** gold stars for 50, 100 and 3-wicket hauls. Small versions on the home-page match cards and in the scoring console |
| Start-up | A cricket intro (the ball knocks the bails off and the CricLive name builds up), then the sign-in screen. Visitors can still choose **Just watch the scores as a guest** |
| Sign-in with a one-time code | Password **plus a 6-digit code e-mailed to you** (2-step). Codes work once, expire after 5 minutes, allow 5 tries, need a 30-second wait before a resend, and are stored only as a hash |
| Strong passwords | 10+ characters with a capital letter, a lowercase letter, a number and a symbol. Common passwords, runs like 1234, and your own name or e-mail are refused. A live checklist and strength bar show what's missing |
| Real e-mail checks | Format check, typo hints ("Did you mean name@gmail.com?" with a one-click fix), throw-away mail services blocked, and a DNS check that the mail domain can receive mail. The one-time code then proves the inbox is yours |
| More security | New session id at every sign-in, Secure cookie on HTTPS, HSTS, cross-origin isolation headers, a stronger scrypt setting, the same response time whether or not an account exists, current password needed to change your e-mail or password, and a random secret created on first start |
| Downloads | **Match:** a report with charts (Manhattan, worm, run rate by phase, how the runs were scored, partnerships), tips on what to work on, and the full scorecard; ball-by-ball CSV; scorecard CSV. **Player:** a report with 9 charts and a personal improvement plan; every-match CSV. Reports open offline and print or save as PDF. CSV files are protected against spreadsheet formula injection |
| Contact us / Report a bug | Pick bug, question or idea. Your device details can be added if you agree. Robots are blocked by a hidden field, and each network can send 5 messages an hour. Admins get a **Bug reports** tab to reply and mark each message new, in progress or resolved |
| Animation everywhere | Smooth page-to-page transitions, cards that rise into view, numbers that count up, charts that draw themselves, a cricket-ball loading spinner, animated tabs and menus. Everything respects your device's **reduce motion** setting |
| Every screen size | Phone menu, layouts for phone, iPad and laptop, large tap targets on the scoring pad. Tested at 360, 375, 820 and 1366 pixels wide with no sideways scrolling |

## Run it in Visual Studio Code

1. Install **Node.js 22 LTS or newer** from https://nodejs.org (nothing else, there are no packages to install).
2. Unzip the project, then in VS Code choose **File → Open Folder** and select the `CricLive` folder.
3. Open **Terminal → New Terminal** and run:
   ```
   node --no-warnings server.js
   ```
4. Open **http://localhost:3000**

The first start creates the database and plays the demo matches ball by ball (about 7 seconds).

> **Coming from the older London version?** Stop the server, delete `database/criclive.db`, and start again to load the new clubs and the new demo passwords. The server warns you if it finds the old data.

### Logins

| Role | Login | Password |
|---|---|---|
| Admin | `admin` | `Boundary#Six2026` |
| Scorer | `scorer` | `Yorker#Pace2026` |
| Player | `oliver.brown@criclive.test` | `Cover#Drive2026` |

After the password you are asked for the **6-digit code**. Until e-mail is set up (below), the code is shown on screen in a yellow **Development mode** box and printed in the VS Code terminal.

### Send the codes by real e-mail

Open **`.env`** and fill in the SMTP settings. For Gmail:

1. Turn on 2-Step Verification for your Google account, then create an **App password** at https://myaccount.google.com/apppasswords.
2. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=you@gmail.com
   SMTP_PASS=the 16-letter app password
   SMTP_FROM=CricLive <you@gmail.com>
   ```
3. Restart the server. Codes now arrive by e-mail and are never shown on screen.

Outlook / Office 365 uses `SMTP_HOST=smtp.office365.com` and `SMTP_PORT=587`. Staff accounts need an e-mail address: **Admin panel → Staff & roles → Set email**.

### Commands

| Command | What it does |
|---|---|
| `node --no-warnings server.js` or `npm start` | Run the website |
| `npm test` | Run the automated tests (11 groups, 101 checks) |
| `npm run seed` | Wipe the database and reload the demo data |
| `npm run reset` | Wipe everything and keep only the admin and scorer logins (for a real season) |

## Database

**Default: SQLite.** The whole database is one file, `database/criclive.db`, created automatically. To look inside it in VS Code, install the **SQLite Viewer** extension and click the file. Version 4 adds the `otp_codes` and `feedback` tables and the `admins.email` column (an older database is upgraded automatically).

**MySQL / XAMPP:** run `npm install mysql2`, then in **`.env`** set `DB_CLIENT=mysql` and your `MYSQL_...` details. The tables are created automatically.

## Try the new features

1. **Celebrations:** open the live match (`/match.html?id=16`). In a second window, sign in as `admin`, open **Admin panel → Continue scoring**, and press **4**, **6** and **OUT**. Press **End innings** to finish the match and see the win.
2. **Sign-up:** on **Join**, try a weak password or `name@gmial.com`, and watch the checklist and the e-mail hint.
3. **Downloads:** on any match page (under the tabs) or player page (under the AI player type).
4. **Report a bug:** use the footer link, then see it in **Admin panel → Bug reports**.
5. **Phone:** open the site on your phone on the same Wi-Fi (`http://<your-computer's-IP>:3000`), or use your browser's device toolbar (F12).

See **`docs/TECHNICAL.md`** for the architecture, database design, security, AI method and test plan.
