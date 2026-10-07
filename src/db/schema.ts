import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ---------- Enums ---------- */

export const PIPELINE_STAGES = [
  "lead",
  "current",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const pipelineStageEnum = pgEnum("pipeline_stage", PIPELINE_STAGES);
export const leadStatusEnum = pgEnum("lead_status", ["new", "working", "nurturing", "unqualified"]);
export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "member"]);
export const provenanceEnum = pgEnum("provenance", ["sourced", "inferred", "unknown"]);
export const researchStatusEnum = pgEnum("research_status", ["none", "queued", "running", "done", "failed"]);
export const importanceEnum = pgEnum("importance", ["low", "medium", "high"]);
export const opportunityStatusEnum = pgEnum("opportunity_status", ["identified", "pursuing", "dismissed"]);
export const confidenceEnum = pgEnum("confidence", ["low", "medium", "high"]);
export const relevanceEnum = pgEnum("relevance", ["primary", "relevant", "other"]);
export const priorityEnum = pgEnum("priority", ["low", "medium", "high"]);
export const taskStatusEnum = pgEnum("task_status", ["open", "in_progress", "complete"]);
export const campaignStatusEnum = pgEnum("campaign_status", ["draft", "active", "paused", "completed"]);
export const dealStatusEnum = pgEnum("deal_status", ["open", "proposal", "won", "lost"]);
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "done", "failed"]);
export const runStatusEnum = pgEnum("run_status", ["queued", "running", "done", "failed"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
/** Money is stored as integer minor units (pence/cents) to avoid float error. */
const money = (name: string) => bigint(name, { mode: "number" });

/* ---------- Identity & tenancy ---------- */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("GBP"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("wm_user_idx").on(t.userId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_idx").on(t.workspaceId, t.createdAt)],
);

/* ---------- Prospecting ---------- */

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    interpreted: jsonb("interpreted"),
    status: runStatusEnum("status").notNull().default("queued"),
    error: text("error"),
    resultsCount: integer("results_count").notNull().default(0),
    stats: jsonb("stats"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("dr_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const prospects = pgTable(
  "prospects",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    domain: text("domain").notNull(),
    industry: text("industry"),
    location: text("location"),
    description: text("description"),
    companySize: text("company_size"),
    technology: text("technology").array().notNull().default(sql`'{}'::text[]`),
    ecommercePlatform: text("ecommerce_platform"),
    opportunityScore: integer("opportunity_score"),
    pipelineStage: pipelineStageEnum("pipeline_stage").notNull().default("lead"),
    leadStatus: leadStatusEnum("lead_status").notNull().default("new"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    discoverySource: text("discovery_source").notNull().default("manual"),
    discoveryRunId: uuid("discovery_run_id").references(() => discoveryRuns.id, { onDelete: "set null" }),
    discoverySourceUrl: text("discovery_source_url"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    researchStatus: researchStatusEnum("research_status").notNull().default("none"),
    researchError: text("research_error"),
    researchedAt: timestamp("researched_at", { withTimezone: true }),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    nextAction: text("next_action"),
    nextActionAt: date("next_action_at"),
    estimatedValue: money("estimated_value"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prospects_ws_domain_uq").on(t.workspaceId, t.domain),
    index("prospects_ws_stage_idx").on(t.workspaceId, t.pipelineStage),
    index("prospects_ws_score_idx").on(t.workspaceId, t.opportunityScore),
    index("prospects_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("prospects_assigned_idx").on(t.assignedUserId),
    index("prospects_name_idx").on(sql`lower(${t.name})`),
  ],
);

/** One researched attribute of a prospect, with explicit provenance. */
export const prospectFacts = pgTable(
  "prospect_facts",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    value: text("value"),
    provenance: provenanceEnum("provenance").notNull(),
    sourceUrl: text("source_url"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("facts_prospect_key_uq").on(t.prospectId, t.key)],
);

export const opportunityCategories = pgTable(
  "opportunity_categories",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("oc_ws_key_uq").on(t.workspaceId, t.key)],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull().references(() => opportunityCategories.id, { onDelete: "restrict" }),
    score: integer("score").notNull(),
    description: text("description").notNull(),
    evidence: jsonb("evidence").$type<{ text: string; sourceUrl?: string | null }[]>().notNull().default([]),
    importance: importanceEnum("importance").notNull().default("medium"),
    potentialImpact: text("potential_impact"),
    commercialValue: money("commercial_value"),
    recommendedAction: text("recommended_action"),
    status: opportunityStatusEnum("status").notNull().default("identified"),
    origin: text("origin").notNull().default("ai"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("opp_prospect_cat_uq").on(t.prospectId, t.categoryId),
    index("opp_ws_score_idx").on(t.workspaceId, t.score),
    index("opp_ws_status_idx").on(t.workspaceId, t.status),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    jobTitle: text("job_title"),
    email: text("email"),
    linkedinUrl: text("linkedin_url"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceUrl: text("source_url"),
    confidence: confidenceEnum("confidence"),
    relevance: relevanceEnum("relevance").notNull().default("other"),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("contacts_prospect_idx").on(t.prospectId),
    index("contacts_ws_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("contacts_prospect_name_uq").on(t.prospectId, sql`lower(${t.name})`),
  ],
);

/* ---------- Sales ---------- */

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: campaignStatusEnum("status").notNull().default("draft"),
    targetCriteria: text("target_criteria"),
    revenueTarget: money("revenue_target"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const campaignProspects = pgTable(
  "campaign_prospects",
  {
    campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.prospectId] }), index("cp_prospect_idx").on(t.prospectId)],
);

export const deals = pgTable(
  "deals",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: dealStatusEnum("status").notNull().default("open"),
    estimatedValue: money("estimated_value"),
    proposalValue: money("proposal_value"),
    wonValue: money("won_value"),
    /** Copied from the prospect at creation so source attribution survives later edits. */
    discoverySource: text("discovery_source"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("deals_ws_status_idx").on(t.workspaceId, t.status),
    index("deals_prospect_idx").on(t.prospectId),
    index("deals_campaign_idx").on(t.campaignId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").references(() => prospects.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    priority: priorityEnum("priority").notNull().default("medium"),
    status: taskStatusEnum("status").notNull().default("open"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_ws_status_due_idx").on(t.workspaceId, t.status, t.dueDate),
    index("tasks_prospect_idx").on(t.prospectId),
    index("tasks_assigned_idx").on(t.assignedUserId),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").references(() => prospects.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    index("act_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("act_prospect_created_idx").on(t.prospectId, t.createdAt),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("notes_prospect_idx").on(t.prospectId, t.createdAt)],
);

/* ---------- AI ---------- */

export const outreachDrafts = pgTable(
  "outreach_drafts",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: uuid("prospect_id").notNull().references(() => prospects.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    instruction: text("instruction").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("od_prospect_idx").on(t.prospectId, t.createdAt)],
);

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("aic_user_idx").on(t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    conversationId: uuid("conversation_id").notNull().references(() => aiConversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /** Records the assistant surfaced in this turn, so follow-ups like "those" resolve. */
    entities: jsonb("entities").$type<{ type: string; id: string; name: string }[]>(),
    createdAt: createdAt(),
  },
  (t) => [index("aim_conv_idx").on(t.conversationId, t.createdAt)],
);

/** Workspace-level API keys entered in Settings. Stored AES-256-GCM encrypted; plaintext never leaves the server. */
export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    last4: text("last4").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.name] })],
);

/* ---------- Background jobs ---------- */

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull().default({}),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_queue_idx").on(t.status, t.runAt)],
);
