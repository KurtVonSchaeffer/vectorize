/*
  Vectoriser results database (Azure SQL), schema `vec`. Proposal to agree with Vernon (docs/admin-panel.md).

  One row per upload in vec.vectorisation_run, at most one artist review per run in vec.run_review,
  the review reasons the artists pick from, and the learned default settings per type of logo. Files
  (the upload and the vector) live in blob storage; the database keeps only their paths.

  Columns follow what the app sends (src/admin/runs.ts: RunRecord, ReviewRecord, LearnedDefaults),
  so the service maps JSON to rows one to one. Times are UTC. People are Entra ID object IDs
  (from the sign-in token), never names or emails.
*/

CREATE SCHEMA vec;
GO

/* The reasons an artist can give for a touch-up or rejection. Supervisors can add or retire them. */
CREATE TABLE vec.review_reason (
  code        varchar(40)    NOT NULL CONSTRAINT pk_review_reason PRIMARY KEY,
  label       nvarchar(100)  NOT NULL,
  sort_order  smallint       NOT NULL CONSTRAINT df_review_reason_sort DEFAULT 0,
  is_active   bit            NOT NULL CONSTRAINT df_review_reason_active DEFAULT 1
);

/* Default settings per type of logo, proposed by the learning job and approved by a Layout supervisor. */
CREATE TABLE vec.learned_profile (
  profile_id     uniqueidentifier NOT NULL CONSTRAINT pk_learned_profile PRIMARY KEY CONSTRAINT df_learned_profile_id DEFAULT NEWSEQUENTIALID(),
  profile_key    varchar(60)      NOT NULL,  -- e.g. 'flat/medium/lossy' (kind/band/compression)
  settings_json  nvarchar(max)    NOT NULL CONSTRAINT ck_learned_profile_json CHECK (ISJSON(settings_json) = 1),
  sample_size    int              NOT NULL CONSTRAINT ck_learned_profile_sample CHECK (sample_size >= 0),
  usable_rate    decimal(5,4)     NOT NULL CONSTRAINT ck_learned_profile_rate CHECK (usable_rate BETWEEN 0 AND 1),
  baseline_rate  decimal(5,4)     NULL     CONSTRAINT ck_learned_profile_base CHECK (baseline_rate BETWEEN 0 AND 1),
  status         varchar(10)      NOT NULL CONSTRAINT ck_learned_profile_status CHECK (status IN ('proposed', 'active', 'retired')),
  proposed_at    datetime2(0)     NOT NULL CONSTRAINT df_learned_profile_proposed DEFAULT SYSUTCDATETIME(),
  approved_by    varchar(64)      NULL,
  approved_at    datetime2(0)     NULL,
  retired_at     datetime2(0)     NULL,
  CONSTRAINT ck_learned_profile_approved CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
/* Only one active set of defaults per profile: GET /defaults/{profileKey} returns it. */
CREATE UNIQUE INDEX ux_learned_profile_active ON vec.learned_profile (profile_key) WHERE status = 'active';

/* One row per upload vectorised in the admin panel, recorded once its first result was checked. */
CREATE TABLE vec.vectorisation_run (
  run_id               uniqueidentifier NOT NULL CONSTRAINT pk_vectorisation_run PRIMARY KEY,  -- made by the app (RunRecord.runId)
  created_at           datetime2(0)     NOT NULL,
  received_at          datetime2(0)     NOT NULL CONSTRAINT df_run_received DEFAULT SYSUTCDATETIME(),
  artist_id            varchar(64)      NOT NULL,  -- Entra ID object ID, from the token, not from the request body
  engine_version       varchar(40)      NOT NULL,

  -- The upload
  input_name           nvarchar(260)    NOT NULL,
  input_type           varchar(10)      NOT NULL,
  width_px             int              NOT NULL CONSTRAINT ck_run_width CHECK (width_px > 0),
  height_px            int              NOT NULL CONSTRAINT ck_run_height CHECK (height_px > 0),
  input_blob_path      nvarchar(400)    NULL,
  output_blob_path     nvarchar(400)    NULL,

  -- What the engine detected
  art_kind             varchar(10)      NOT NULL CONSTRAINT ck_run_kind CHECK (art_kind IN ('flat', 'lineart', 'pixel', 'photo')),
  colours              smallint         NOT NULL CONSTRAINT ck_run_colours CHECK (colours >= 0),
  gradients            smallint         NOT NULL CONSTRAINT ck_run_gradients CHECK (gradients >= 0),
  fine_share           decimal(5,4)     NOT NULL CONSTRAINT ck_run_fine CHECK (fine_share BETWEEN 0 AND 1),
  has_alpha            bit              NOT NULL,
  compression          decimal(5,4)     NOT NULL CONSTRAINT ck_run_compression CHECK (compression BETWEEN 0 AND 1),
  texture_share        decimal(5,4)     NOT NULL CONSTRAINT df_run_texture DEFAULT 0 CONSTRAINT ck_run_texture CHECK (texture_share BETWEEN 0 AND 1),
  is_illustration      bit              NOT NULL CONSTRAINT df_run_illustration DEFAULT 0,  -- traced with a shading layer, or simplified

  -- Complexity (src/admin/complexity.ts); the parts are kept so the weights can be tuned later
  complexity_score     tinyint          NOT NULL CONSTRAINT ck_run_score CHECK (complexity_score BETWEEN 0 AND 100),
  complexity_band      varchar(8)       NOT NULL CONSTRAINT ck_run_band CHECK (complexity_band IN ('simple', 'medium', 'complex')),
  complexity_parts     nvarchar(400)    NOT NULL CONSTRAINT ck_run_parts CHECK (ISJSON(complexity_parts) = 1),
  profile_key          varchar(60)      NOT NULL,

  -- How it was made
  settings_json        nvarchar(max)    NOT NULL CONSTRAINT ck_run_settings CHECK (ISJSON(settings_json) = 1),
  defaults_id          uniqueidentifier NULL CONSTRAINT fk_run_defaults REFERENCES vec.learned_profile (profile_id),
  paths                int              NOT NULL CONSTRAINT ck_run_paths CHECK (paths >= 0),
  processing_ms        int              NOT NULL CONSTRAINT ck_run_ms CHECK (processing_ms >= 0),

  -- The engine's own check against the upload (null when it couldn't run)
  auto_verdict         varchar(12)      NULL CONSTRAINT ck_run_verdict CHECK (auto_verdict IN ('ready', 'check', 'not-suitable')),
  edge_recall          decimal(5,4)     NULL,
  wrong_share          decimal(7,6)     NULL,
  fine_lost            smallint         NULL,

  -- The order it belongs to, when the artist entered it (filled from the review)
  logo_id              varchar(64)      NULL,
  case_no              varchar(64)      NULL,
  sales_order          varchar(64)      NULL
);
CREATE INDEX ix_run_created     ON vec.vectorisation_run (created_at);
CREATE INDEX ix_run_band_week   ON vec.vectorisation_run (complexity_band, created_at) INCLUDE (art_kind, auto_verdict);
CREATE INDEX ix_run_artist      ON vec.vectorisation_run (artist_id, created_at);
CREATE INDEX ix_run_profile     ON vec.vectorisation_run (profile_key, created_at);
CREATE INDEX ix_run_logo        ON vec.vectorisation_run (logo_id) WHERE logo_id IS NOT NULL;
CREATE INDEX ix_run_case        ON vec.vectorisation_run (case_no) WHERE case_no IS NOT NULL;
CREATE INDEX ix_run_sales_order ON vec.vectorisation_run (sales_order) WHERE sales_order IS NOT NULL;

/* The artist's verdict: at most one per run (a second save replaces the first). */
CREATE TABLE vec.run_review (
  run_id               uniqueidentifier NOT NULL CONSTRAINT pk_run_review PRIMARY KEY
                                        CONSTRAINT fk_review_run REFERENCES vec.vectorisation_run (run_id) ON DELETE CASCADE,
  reviewer_id          varchar(64)      NOT NULL,  -- Entra ID object ID, from the token
  reviewed_at          datetime2(0)     NOT NULL,
  outcome              varchar(10)      NOT NULL CONSTRAINT ck_review_outcome CHECK (outcome IN ('usable', 'touch-up', 'rejected')),
  reason_code          varchar(40)      NULL CONSTRAINT fk_review_reason REFERENCES vec.review_reason (code),
  -- The type of artwork as the artist confirmed it (src/admin/runs.ts ASSET_TYPES); suggested from the detection
  asset_type           varchar(12)      NULL CONSTRAINT ck_review_asset CHECK (asset_type IN ('wordmark', 'logo', 'badge', 'mascot', 'line-art', 'photo')),
  -- How sure the artist is (optional): separates borderline rejects from hard ones
  confidence           varchar(6)       NULL CONSTRAINT ck_review_confidence CHECK (confidence IN ('low', 'medium', 'high')),
  -- The vector as reviewed (the run has the first result): its paths and how it was made
  final_paths          int              NULL CONSTRAINT ck_review_paths CHECK (final_paths >= 0),
  final_mode           varchar(24)      NULL CONSTRAINT ck_review_mode CHECK (final_mode IN ('logo', 'illustration-detailed', 'illustration-simplified', 'line-art', 'photo', 'pixel')),
  comment              nvarchar(2000)   NULL,
  minutes_saved        smallint         NOT NULL CONSTRAINT ck_review_minutes CHECK (minutes_saved BETWEEN -240 AND 240),
  final_settings_json  nvarchar(max)    NOT NULL CONSTRAINT ck_review_settings CHECK (ISJSON(final_settings_json) = 1),
  final_auto_verdict   varchar(12)      NULL CONSTRAINT ck_review_verdict CHECK (final_auto_verdict IN ('ready', 'check', 'not-suitable')),
  CONSTRAINT ck_review_reason_needed CHECK (outcome = 'usable' OR reason_code IS NOT NULL)
);
CREATE INDEX ix_review_outcome ON vec.run_review (outcome, reviewed_at);
GO

/* The starting reasons (src/admin/runs.ts REVIEW_REASONS). */
INSERT INTO vec.review_reason (code, label, sort_order) VALUES
  ('lost-detail',     N'Lost fine detail',             10),
  ('wrong-colours',   N'Wrong colours',                20),
  ('gradient-lost',   N'Gradient lost',                30),
  ('text-broken',     N'Text broken',                  40),
  ('too-many-nodes',  N'Too many nodes',               50),
  ('shapes-changed',  N'Shapes changed',               60),
  ('background-left', N'Background left in',           70),
  ('not-recognisable', N'Character or subject not recognisable', 75),
  ('low-resolution',  N'Artwork too low resolution',   80),
  ('not-vector',      N'Not suitable for vector',      90);
GO

/*
  For the weekly Power BI report: one row per run with its review (if any), and the week it was made.
  Success rate per band = usable / reviewed; logged rate = reviewed / runs.
*/
CREATE VIEW vec.v_run_results AS
SELECT
  r.run_id,
  r.created_at,
  -- The Monday of the run's week, whatever the server's DATEFIRST setting.
  DATEADD(day, -((DATEPART(weekday, CAST(r.created_at AS date)) + @@DATEFIRST - 2) % 7), CAST(r.created_at AS date)) AS week_start,
  r.artist_id,
  r.art_kind,
  r.is_illustration,
  r.texture_share,
  r.complexity_band,
  r.complexity_score,
  r.profile_key,
  r.auto_verdict,
  r.processing_ms,
  r.defaults_id,
  r.logo_id,
  r.case_no,
  r.sales_order,
  v.outcome,
  v.reason_code,
  v.asset_type,
  v.confidence,
  v.final_paths,
  v.final_mode,
  v.minutes_saved,
  v.final_auto_verdict,
  CASE WHEN v.run_id IS NULL THEN 0 ELSE 1 END AS is_reviewed,
  CASE WHEN v.outcome = 'usable' THEN 1 ELSE 0 END AS is_usable
FROM vec.vectorisation_run r
LEFT JOIN vec.run_review v ON v.run_id = r.run_id;
GO

/*
  Retention (decision 10: 12 months). Run monthly from the service's timer function; the service
  deletes each run's blobs first, then the rows (reviews go with their run).
    DELETE FROM vec.vectorisation_run WHERE created_at < DATEADD(month, -12, SYSUTCDATETIME());
*/
