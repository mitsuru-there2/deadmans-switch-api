import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
// Device credentials are separate from store transaction references and stored only as hashes.
export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("device_credentials_user_idx").on(t.userId)],
);
export const contactVerifications = sqliteTable("contact_verifications", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  email: text().notNull(),
  name: text().notNull(),
  expiresAt: integer("expires_at").notNull(),
});
export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text(),
    password: text(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);
export const verification = sqliteTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
export const rateLimit = sqliteTable("rate_limit", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: integer("last_request").notNull(),
});

export const profiles = sqliteTable(
  "profiles",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text({ enum: ["draft", "active", "grace", "paused", "held", "released"] })
      .notNull()
      .default("draft"),
    version: integer().notNull().default(1),
    inactivityDays: integer("inactivity_days").notNull().default(30),
    graceDays: integer("grace_days").notNull().default(7),
    lastCheckInAt: integer("last_check_in_at"),
    graceStartedAt: integer("grace_started_at"),
    warningAcceptedAt: integer("warning_accepted_at"),
    lastReminderAt: integer("last_reminder_at"),
    holdReason: text("hold_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("profile_state_idx").on(t.state)],
);
export const recipients = sqliteTable(
  "recipients",
  {
    id: text().primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    channel: text({ enum: ["email", "sms"] }).notNull(),
    contact: text().notNull(),
    status: text({ enum: ["pending", "accepted", "declined", "reported"] })
      .notNull()
      .default("pending"),
    invitationHash: text("invitation_hash").unique(),
    invitationExpiresAt: integer("invitation_expires_at"),
    acceptedAt: integer("accepted_at"),
    lastInvitedAt: integer("last_invited_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("recipient_profile_idx").on(t.profileId)],
);
export const messages = sqliteTable("messages", {
  id: text().primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  recipientId: text("recipient_id")
    .notNull()
    .unique()
    .references(() => recipients.id, { onDelete: "cascade" }),
  ciphertext: text().notNull(),
  revision: integer().notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
export const devices = sqliteTable("devices", {
  id: text().primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  token: text().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});
export const entitlements = sqliteTable("entitlements", {
  profileId: text("profile_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  plan: text({ enum: ["basic", "plus"] }).notNull(),
  status: text({ enum: ["active", "grace", "expired", "revoked"] }).notNull(),
  validUntil: integer("valid_until").notNull(),
  sourceVersion: integer("source_version").notNull(),
});
export const releases = sqliteTable(
  "releases",
  {
    id: text().primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("release_version_unique").on(t.profileId, t.version)],
);
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text().primaryKey(),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    ciphertext: text().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    messageRevision: integer("message_revision"),
    expiresAt: integer("expires_at").notNull(),
    viewedAt: integer("viewed_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("release_recipient_unique").on(t.releaseId, t.recipientId)],
);
// A delivery is an immutable snapshot. Its hash also identifies legacy snapshots
// created before messageRevision was recorded.
export const openingConsents = sqliteTable(
  "opening_consents",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    messageRevision: integer("message_revision"),
    snapshotHash: text("snapshot_hash").notNull(),
    noticeVersion: text("notice_version").notNull(),
    confirmedAt: integer("confirmed_at").notNull(),
  },
  (t) => [
    uniqueIndex("opening_consent_unique").on(
      t.deliveryId,
      t.userId,
      t.snapshotHash,
      t.noticeVersion,
    ),
  ],
);
export const outbox = sqliteTable(
  "outbox",
  {
    id: text().primaryKey(),
    profileId: text("profile_id").references(() => profiles.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id").references(() => recipients.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    version: integer(),
    kind: text({
      enum: ["auth", "invitation", "reminder", "warning", "final", "self_test"],
    }).notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: text().notNull(),
    state: text({
      enum: ["pending", "sending", "accepted", "delivered", "failed", "uncertain", "cancelled"],
    })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: integer("available_at").notNull(),
    claimedAt: integer("claimed_at"),
    providerId: text("provider_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("outbox_pending_idx").on(t.state, t.availableAt)],
);
export const audit = sqliteTable(
  "audit",
  {
    id: text().primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    action: text().notNull(),
    version: integer().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_profile_idx").on(t.profileId, t.createdAt)],
);
export const systemHealth = sqliteTable("system_health", {
  id: text().primaryKey(),
  lastTickAt: integer("last_tick_at"),
  lastProbeAt: integer("last_probe_at"),
  incidentAt: integer("incident_at"),
  recoveredAt: integer("recovered_at"),
});
export const webhookEvents = sqliteTable("webhook_events", {
  id: text().primaryKey(),
  createdAt: integer("created_at").notNull(),
});
export const publicRateLimits = sqliteTable("public_rate_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  expiresAt: integer("expires_at").notNull(),
});
export type Profile = typeof profiles.$inferSelect;

export const storeSubscriptions = sqliteTable(
  "store_subscriptions",
  {
    id: text().primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    store: text({ enum: ["apple", "google"] }).notNull(),
    referenceHash: text("reference_hash").notNull().unique(),
    reference: text().notNull(),
    productId: text("product_id").notNull(),
    plan: text({ enum: ["basic", "plus"] }).notNull(),
    status: text({ enum: ["active", "grace", "expired", "revoked"] }).notNull(),
    validUntil: integer("valid_until").notNull(),
    verifiedAt: integer("verified_at").notNull(),
    ownerVerifiedAt: integer("owner_verified_at"),
    nextCheckAt: integer("next_check_at").notNull(),
  },
  (t) => [
    index("subscription_profile_idx").on(t.profileId),
    index("subscription_refresh_idx").on(t.nextCheckAt),
  ],
);
