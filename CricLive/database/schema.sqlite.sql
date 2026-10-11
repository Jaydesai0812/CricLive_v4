-- =====================================================================
--  CricLive database schema  (SQLite version)
--  This file is executed automatically when the server starts.
--  One single database holds everything: admins, players, teams,
--  tournaments, matches, ball-by-ball scoring and player career stats.
-- =====================================================================

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  email         VARCHAR(100),                           -- one-time login codes are sent here
  password_hash VARCHAR(200) NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'admin',   -- admin | scorer
  created_at    DATETIME
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        VARCHAR(64) PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       VARCHAR(60) NOT NULL UNIQUE,
  short_name VARCHAR(6)  NOT NULL,
  city       VARCHAR(60),
  color      VARCHAR(7)  NOT NULL DEFAULT '#1f7a4d',
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name    VARCHAR(40) NOT NULL,
  last_name     VARCHAR(40) NOT NULL,
  email         VARCHAR(100) UNIQUE,
  phone         VARCHAR(15),
  password_hash VARCHAR(200),
  city          VARCHAR(60),
  state         VARCHAR(60),
  dob           DATE,
  role          VARCHAR(20) NOT NULL DEFAULT 'Batsman',
  batting_style VARCHAR(30),
  bowling_style VARCHAR(40),
  jersey_no     INTEGER,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at    DATETIME
);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);

CREATE TABLE IF NOT EXISTS tournaments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       VARCHAR(80) NOT NULL,
  organizer  VARCHAR(80),
  venue      VARCHAR(80),
  start_date DATE,
  end_date   DATE,
  overs      INTEGER NOT NULL DEFAULT 20,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS tournament_teams (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id   INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  team1_id        INTEGER NOT NULL REFERENCES teams(id),
  team2_id        INTEGER NOT NULL REFERENCES teams(id),
  venue           VARCHAR(80),
  match_date      DATETIME,
  overs           INTEGER NOT NULL DEFAULT 20,
  toss_winner_id  INTEGER,
  toss_decision   VARCHAR(4),
  status          VARCHAR(12) NOT NULL DEFAULT 'scheduled',  -- scheduled | live | completed | abandoned
  current_innings INTEGER NOT NULL DEFAULT 0,
  winner_team_id  INTEGER,
  result_text     VARCHAR(120),
  created_at      DATETIME,
  updated_at      DATETIME
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

-- playing XI of each team for a match
CREATE TABLE IF NOT EXISTS match_players (
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id   INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS innings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id            INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_no          INTEGER NOT NULL,
  batting_team_id     INTEGER NOT NULL,
  bowling_team_id     INTEGER NOT NULL,
  runs                INTEGER NOT NULL DEFAULT 0,
  wickets             INTEGER NOT NULL DEFAULT 0,
  legal_balls         INTEGER NOT NULL DEFAULT 0,
  extras              INTEGER NOT NULL DEFAULT 0,
  wides               INTEGER NOT NULL DEFAULT 0,
  noballs             INTEGER NOT NULL DEFAULT 0,
  byes                INTEGER NOT NULL DEFAULT 0,
  legbyes             INTEGER NOT NULL DEFAULT 0,
  target              INTEGER,
  striker_id          INTEGER,
  non_striker_id      INTEGER,
  bowler_id           INTEGER,
  last_over_bowler_id INTEGER,
  status              VARCHAR(12) NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  UNIQUE (match_id, innings_no)
);

-- every single delivery (source of truth for all scores)
CREATE TABLE IF NOT EXISTS balls (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id                 INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id               INTEGER NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  seq                      INTEGER NOT NULL,
  over_no                  INTEGER NOT NULL,
  ball_in_over             INTEGER NOT NULL,
  batsman_id               INTEGER NOT NULL,
  non_striker_id           INTEGER,
  bowler_id                INTEGER NOT NULL,
  runs_bat                 INTEGER NOT NULL DEFAULT 0,
  extra_type               VARCHAR(2),          -- wd | nb | b | lb
  extra_runs               INTEGER NOT NULL DEFAULT 0,
  total_runs               INTEGER NOT NULL DEFAULT 0,
  is_legal                 INTEGER NOT NULL DEFAULT 1,
  is_wicket                INTEGER NOT NULL DEFAULT 0,
  wicket_type              VARCHAR(16),
  player_out_id            INTEGER,
  fielder_id               INTEGER,
  commentary               VARCHAR(255),
  prev_striker_id          INTEGER,
  prev_non_striker_id      INTEGER,
  prev_bowler_id           INTEGER,
  prev_last_over_bowler_id INTEGER,
  created_at               DATETIME
);
CREATE INDEX IF NOT EXISTS idx_balls_innings ON balls(innings_id, seq);
CREATE INDEX IF NOT EXISTS idx_balls_match ON balls(match_id, seq);

CREATE TABLE IF NOT EXISTS batting_scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id  INTEGER NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  bat_order   INTEGER NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 0,
  balls       INTEGER NOT NULL DEFAULT 0,
  fours       INTEGER NOT NULL DEFAULT 0,
  sixes       INTEGER NOT NULL DEFAULT 0,
  is_out      INTEGER NOT NULL DEFAULT 0,
  wicket_type VARCHAR(16),
  bowler_id   INTEGER,
  fielder_id  INTEGER,
  UNIQUE (innings_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_bat_player ON batting_scores(player_id);

CREATE TABLE IF NOT EXISTS bowling_scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id  INTEGER NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  bowl_order  INTEGER NOT NULL,
  legal_balls INTEGER NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0,
  wickets     INTEGER NOT NULL DEFAULT 0,
  maidens     INTEGER NOT NULL DEFAULT 0,
  wides       INTEGER NOT NULL DEFAULT 0,
  noballs     INTEGER NOT NULL DEFAULT 0,
  dots        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (innings_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_bowl_player ON bowling_scores(player_id);

-- career totals of every player, updated automatically after every ball
CREATE TABLE IF NOT EXISTS player_stats (
  player_id       INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  matches         INTEGER NOT NULL DEFAULT 0,
  bat_innings     INTEGER NOT NULL DEFAULT 0,
  not_outs        INTEGER NOT NULL DEFAULT 0,
  runs            INTEGER NOT NULL DEFAULT 0,
  balls_faced     INTEGER NOT NULL DEFAULT 0,
  fours           INTEGER NOT NULL DEFAULT 0,
  sixes           INTEGER NOT NULL DEFAULT 0,
  highest         INTEGER NOT NULL DEFAULT 0,
  highest_not_out INTEGER NOT NULL DEFAULT 0,
  fifties         INTEGER NOT NULL DEFAULT 0,
  hundreds        INTEGER NOT NULL DEFAULT 0,
  ducks           INTEGER NOT NULL DEFAULT 0,
  bowl_innings    INTEGER NOT NULL DEFAULT 0,
  balls_bowled    INTEGER NOT NULL DEFAULT 0,
  runs_conceded   INTEGER NOT NULL DEFAULT 0,
  wickets         INTEGER NOT NULL DEFAULT 0,
  maidens         INTEGER NOT NULL DEFAULT 0,
  best_wickets    INTEGER NOT NULL DEFAULT 0,
  best_runs       INTEGER NOT NULL DEFAULT 0,
  catches         INTEGER NOT NULL DEFAULT 0,
  stumpings       INTEGER NOT NULL DEFAULT 0,
  run_outs        INTEGER NOT NULL DEFAULT 0,
  updated_at      DATETIME
);

-- teams a player follows (gets notifications about their matches)
CREATE TABLE IF NOT EXISTS follows (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at DATETIME,
  PRIMARY KEY (player_id, team_id)
);

-- match alerts / notifications for logged-in users
CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_type VARCHAR(10) NOT NULL,        -- player | admin
  recipient_id   INTEGER NOT NULL,
  kind           VARCHAR(20) NOT NULL,        -- fixture | start | innings | result | milestone | reminder
  title          VARCHAR(120) NOT NULL,
  body           VARCHAR(255),
  link           VARCHAR(120),
  is_read        INTEGER NOT NULL DEFAULT 0,
  created_at     DATETIME
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_type, recipient_id, is_read);

-- record of every admin / scorer action (security & accountability)
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      VARCHAR(60) NOT NULL,
  role       VARCHAR(10),
  action     VARCHAR(60) NOT NULL,
  details    VARCHAR(255),
  ip         VARCHAR(45),
  created_at DATETIME
);


-- one-time passcodes (OTP) for sign-in and registration.
-- Only a salted SHA-256 hash of the 6-digit code is stored, never the code.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          VARCHAR(48) PRIMARY KEY,                -- random challenge id given to the browser
  purpose     VARCHAR(12) NOT NULL,                   -- login | register
  account     VARCHAR(10),                            -- player | admin
  account_id  INTEGER,
  email       VARCHAR(100) NOT NULL,
  code_hash   VARCHAR(64) NOT NULL,
  payload     TEXT,                                   -- pending registration details
  attempts    INTEGER NOT NULL DEFAULT 0,
  resends     INTEGER NOT NULL DEFAULT 0,
  last_sent   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  ip          VARCHAR(45),
  created_at  DATETIME
);

-- contact form and bug reports
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        VARCHAR(12) NOT NULL,                   -- bug | question | idea
  name        VARCHAR(80) NOT NULL,
  email       VARCHAR(100) NOT NULL,
  page        VARCHAR(120),
  message     TEXT NOT NULL,
  device      VARCHAR(200),
  status      VARCHAR(12) NOT NULL DEFAULT 'new',     -- new | in_progress | resolved
  ip          VARCHAR(45),
  created_at  DATETIME
);
