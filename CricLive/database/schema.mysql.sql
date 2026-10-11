-- =====================================================================
--  CricLive database schema  (MySQL / MariaDB / XAMPP version)
--  This file is executed automatically when the server starts with DB_CLIENT=mysql.
--  You can also import it manually in phpMyAdmin / MySQL Workbench:
--     CREATE DATABASE criclive;  USE criclive;  then run this file.
--  One single database holds everything: admins, players, teams,
--  tournaments, matches, ball-by-ball scoring and player career stats.
-- =====================================================================

CREATE TABLE IF NOT EXISTS admins (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  email         VARCHAR(100),                           -- one-time login codes are sent here
  password_hash VARCHAR(200) NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'admin',   -- admin | scorer
  created_at    DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  sid        VARCHAR(64) PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS teams (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL UNIQUE,
  short_name VARCHAR(6)  NOT NULL,
  city       VARCHAR(60),
  color      VARCHAR(7)  NOT NULL DEFAULT '#1f7a4d',
  created_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS players (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
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
  jersey_no     INT,
  team_id       INT,
  created_at    DATETIME,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_players_team ON players(team_id);

CREATE TABLE IF NOT EXISTS tournaments (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(80) NOT NULL,
  organizer  VARCHAR(80),
  venue      VARCHAR(80),
  start_date DATE,
  end_date   DATE,
  overs      INT NOT NULL DEFAULT 20,
  created_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tournament_teams (
  tournament_id INT NOT NULL,
  team_id       INT NOT NULL,
  PRIMARY KEY (tournament_id, team_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS matches (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tournament_id   INT,
  team1_id        INT NOT NULL,
  team2_id        INT NOT NULL,
  venue           VARCHAR(80),
  match_date      DATETIME,
  overs           INT NOT NULL DEFAULT 20,
  toss_winner_id  INT,
  toss_decision   VARCHAR(4),
  status          VARCHAR(12) NOT NULL DEFAULT 'scheduled',  -- scheduled | live | completed | abandoned
  current_innings INT NOT NULL DEFAULT 0,
  winner_team_id  INT,
  result_text     VARCHAR(120),
  created_at      DATETIME,
  updated_at      DATETIME,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE SET NULL,
  FOREIGN KEY (team1_id) REFERENCES teams(id),
  FOREIGN KEY (team2_id) REFERENCES teams(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_matches_status ON matches(status);

-- playing XI of each team for a match
CREATE TABLE IF NOT EXISTS match_players (
  match_id  INT NOT NULL,
  team_id   INT NOT NULL,
  player_id INT NOT NULL,
  PRIMARY KEY (match_id, player_id),
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS innings (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id            INT NOT NULL,
  innings_no          INT NOT NULL,
  batting_team_id     INT NOT NULL,
  bowling_team_id     INT NOT NULL,
  runs                INT NOT NULL DEFAULT 0,
  wickets             INT NOT NULL DEFAULT 0,
  legal_balls         INT NOT NULL DEFAULT 0,
  extras              INT NOT NULL DEFAULT 0,
  wides               INT NOT NULL DEFAULT 0,
  noballs             INT NOT NULL DEFAULT 0,
  byes                INT NOT NULL DEFAULT 0,
  legbyes             INT NOT NULL DEFAULT 0,
  target              INT,
  striker_id          INT,
  non_striker_id      INT,
  bowler_id           INT,
  last_over_bowler_id INT,
  status              VARCHAR(12) NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  UNIQUE (match_id, innings_no),
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- every single delivery (source of truth for all scores)
CREATE TABLE IF NOT EXISTS balls (
  id                       INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  match_id                 INT NOT NULL,
  innings_id               INT NOT NULL,
  seq                      INT NOT NULL,
  over_no                  INT NOT NULL,
  ball_in_over             INT NOT NULL,
  batsman_id               INT NOT NULL,
  non_striker_id           INT,
  bowler_id                INT NOT NULL,
  runs_bat                 INT NOT NULL DEFAULT 0,
  extra_type               VARCHAR(2),          -- wd | nb | b | lb
  extra_runs               INT NOT NULL DEFAULT 0,
  total_runs               INT NOT NULL DEFAULT 0,
  is_legal                 INT NOT NULL DEFAULT 1,
  is_wicket                INT NOT NULL DEFAULT 0,
  wicket_type              VARCHAR(16),
  player_out_id            INT,
  fielder_id               INT,
  commentary               VARCHAR(255),
  prev_striker_id          INT,
  prev_non_striker_id      INT,
  prev_bowler_id           INT,
  prev_last_over_bowler_id INT,
  created_at               DATETIME,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY (innings_id) REFERENCES innings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_balls_innings ON balls(innings_id, seq);
CREATE INDEX idx_balls_match ON balls(match_id, seq);

CREATE TABLE IF NOT EXISTS batting_scores (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  innings_id  INT NOT NULL,
  match_id    INT NOT NULL,
  player_id   INT NOT NULL,
  team_id     INT NOT NULL,
  bat_order   INT NOT NULL,
  runs        INT NOT NULL DEFAULT 0,
  balls       INT NOT NULL DEFAULT 0,
  fours       INT NOT NULL DEFAULT 0,
  sixes       INT NOT NULL DEFAULT 0,
  is_out      INT NOT NULL DEFAULT 0,
  wicket_type VARCHAR(16),
  bowler_id   INT,
  fielder_id  INT,
  UNIQUE (innings_id, player_id),
  FOREIGN KEY (innings_id) REFERENCES innings(id) ON DELETE CASCADE,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_bat_player ON batting_scores(player_id);

CREATE TABLE IF NOT EXISTS bowling_scores (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  innings_id  INT NOT NULL,
  match_id    INT NOT NULL,
  player_id   INT NOT NULL,
  team_id     INT NOT NULL,
  bowl_order  INT NOT NULL,
  legal_balls INT NOT NULL DEFAULT 0,
  runs        INT NOT NULL DEFAULT 0,
  wickets     INT NOT NULL DEFAULT 0,
  maidens     INT NOT NULL DEFAULT 0,
  wides       INT NOT NULL DEFAULT 0,
  noballs     INT NOT NULL DEFAULT 0,
  dots        INT NOT NULL DEFAULT 0,
  UNIQUE (innings_id, player_id),
  FOREIGN KEY (innings_id) REFERENCES innings(id) ON DELETE CASCADE,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_bowl_player ON bowling_scores(player_id);

-- career totals of every player, updated automatically after every ball
CREATE TABLE IF NOT EXISTS player_stats (
  player_id       INT PRIMARY KEY,
  matches         INT NOT NULL DEFAULT 0,
  bat_innings     INT NOT NULL DEFAULT 0,
  not_outs        INT NOT NULL DEFAULT 0,
  runs            INT NOT NULL DEFAULT 0,
  balls_faced     INT NOT NULL DEFAULT 0,
  fours           INT NOT NULL DEFAULT 0,
  sixes           INT NOT NULL DEFAULT 0,
  highest         INT NOT NULL DEFAULT 0,
  highest_not_out INT NOT NULL DEFAULT 0,
  fifties         INT NOT NULL DEFAULT 0,
  hundreds        INT NOT NULL DEFAULT 0,
  ducks           INT NOT NULL DEFAULT 0,
  bowl_innings    INT NOT NULL DEFAULT 0,
  balls_bowled    INT NOT NULL DEFAULT 0,
  runs_conceded   INT NOT NULL DEFAULT 0,
  wickets         INT NOT NULL DEFAULT 0,
  maidens         INT NOT NULL DEFAULT 0,
  best_wickets    INT NOT NULL DEFAULT 0,
  best_runs       INT NOT NULL DEFAULT 0,
  catches         INT NOT NULL DEFAULT 0,
  stumpings       INT NOT NULL DEFAULT 0,
  run_outs        INT NOT NULL DEFAULT 0,
  updated_at      DATETIME,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- teams a player follows (gets notifications about their matches)
CREATE TABLE IF NOT EXISTS follows (
  player_id  INT NOT NULL,
  team_id    INT NOT NULL,
  created_at DATETIME,
  PRIMARY KEY (player_id, team_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- match alerts / notifications for logged-in users
CREATE TABLE IF NOT EXISTS notifications (
  id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recipient_type VARCHAR(10) NOT NULL,        -- player | admin
  recipient_id   INT NOT NULL,
  kind           VARCHAR(20) NOT NULL,        -- fixture | start | innings | result | milestone | reminder
  title          VARCHAR(120) NOT NULL,
  body           VARCHAR(255),
  link           VARCHAR(120),
  is_read        INT NOT NULL DEFAULT 0,
  created_at     DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_notif_recipient ON notifications(recipient_type, recipient_id, is_read);

-- record of every admin / scorer action (security & accountability)
CREATE TABLE IF NOT EXISTS audit_log (
  id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor      VARCHAR(60) NOT NULL,
  role       VARCHAR(10),
  action     VARCHAR(60) NOT NULL,
  details    VARCHAR(255),
  ip         VARCHAR(45),
  created_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- one-time passcodes (OTP) for sign-in and registration.
-- Only a salted SHA-256 hash of the 6-digit code is stored, never the code.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          VARCHAR(48) PRIMARY KEY,                -- random challenge id given to the browser
  purpose     VARCHAR(12) NOT NULL,                   -- login | register
  account     VARCHAR(10),                            -- player | admin
  account_id  INT,
  email       VARCHAR(100) NOT NULL,
  code_hash   VARCHAR(64) NOT NULL,
  payload     TEXT,                                   -- pending registration details
  attempts    INT NOT NULL DEFAULT 0,
  resends     INT NOT NULL DEFAULT 0,
  last_sent   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used        INT NOT NULL DEFAULT 0,
  ip          VARCHAR(45),
  created_at  DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- contact form and bug reports
CREATE TABLE IF NOT EXISTS feedback (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind        VARCHAR(12) NOT NULL,                   -- bug | question | idea
  name        VARCHAR(80) NOT NULL,
  email       VARCHAR(100) NOT NULL,
  page        VARCHAR(120),
  message     TEXT NOT NULL,
  device      VARCHAR(200),
  status      VARCHAR(12) NOT NULL DEFAULT 'new',     -- new | in_progress | resolved
  ip          VARCHAR(45),
  created_at  DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
