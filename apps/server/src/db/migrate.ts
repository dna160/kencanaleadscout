/**
 * Idempotent schema creation (microPRD §14). Safe to run on every boot.
 *
 * Tables:
 *   leads        — seeded once from data/leads.json
 *   outcomes     — one upserted row per call attempt
 *   enrichments  — scraper bridge: WA numbers keyed by normalized company name,
 *                  so the cockpit can pre-fill a lead before the rep dials.
 */
import type { Sql } from "./client.js";
import { getSql } from "./client.js";
import { normalizeProjectCategory } from "../util/projectCategory.js";
import { normalizeMiraeCategory } from "../util/miraeCategory.js";

export async function runMigrations(db: Sql = getSql()!): Promise<void> {
  // ── Legacy Modules A–C (best-effort; failures must not block Module D) ────
  // If the leads/outcomes/enrichments tables are absent or already diverged,
  // we still need salespeople + visit tables to exist so the app can boot.
  try {
    await db`
      create table if not exists leads (
        id        text primary key,
        day       int  not null,
        rep       text not null,
        priority  text,
        company   text,
        town      text,
        province  text,
        landline  text,
        ask_for   text,
        role      text,
        email     text,
        website   text
      )
    `;

    await db`
      create table if not exists outcomes (
        lead_id     text primary key references leads(id),
        status      text,
        wa_number   text,
        pic_name    text,
        sample_sent boolean default false,
        updated_at  timestamptz default now(),
        updated_by  text
      )
    `;

    // Part C — pipeline/handler additions (microPRD §24). Additive only; never drop.
    await db`alter table outcomes add column if not exists stage       text default 'captured'`;
    await db`alter table outcomes add column if not exists handler     text`;
    await db`alter table outcomes add column if not exists captured_at timestamptz`;
    await db`alter table outcomes add column if not exists messaged_at timestamptz`;
    await db`alter table outcomes add column if not exists replied_at  timestamptz`;
    await db`alter table outcomes add column if not exists meeting_at  timestamptz`;
    await db`alter table outcomes add column if not exists pipe_note   text`;

    await db`
      create table if not exists enrichments (
        company_norm   text primary key,
        company        text,
        wa_numbers     text,
        mobile_numbers text,
        source         text,
        confidence     text,
        pages_checked  int,
        updated_at     timestamptz default now()
      )
    `;

    // Helpful indexes for the cockpit + champion queries.
    // Sales Lead: flag leads previously contacted by the sales lead.
    await db`alter table leads add column if not exists sl_flag       boolean default false`;
    await db`alter table leads add column if not exists sl_note       text`;
    // Transaction review: invoice ID, alias name used, and review outcome.
    await db`alter table leads add column if not exists invoice_id    text`;
    await db`alter table leads add column if not exists transacted_as text`;
    await db`alter table leads add column if not exists review_status text`;
    // Dedup / relevance flag set by scripts (e.g. irrelevant_manufacturer).
    await db`alter table leads add column if not exists flag          text`;

    await db`create index if not exists leads_rep_day_idx on leads (rep, day)`;
    await db`create index if not exists outcomes_status_idx on outcomes (status)`;
    await db`create index if not exists outcomes_stage_idx on outcomes (stage)`;
  } catch (legacyErr) {
    // Non-fatal: log and continue so Module D tables always get created.
    console.error("[migrate] legacy A–C step failed (non-fatal):", legacyErr);
  }

  // ── Module D — Visitation Log ──────────────────────────────────────────────

  // visit_lists: wrapped separately because the unique index uses an expression
  // (lower(value)), which cannot be expressed as an inline table constraint in
  // PostgreSQL — it must be a separate CREATE UNIQUE INDEX statement.
  try {
    await db`
      create table if not exists visit_lists (
        id     bigserial primary key,
        type   text not null,
        value  text not null,
        active boolean not null default true
      )
    `;
    await db`
      create unique index if not exists visit_lists_type_value_idx
        on visit_lists (type, lower(value))
    `;
  } catch (vlErr) {
    console.error("[migrate] visit_lists step failed (non-fatal):", vlErr);
  }

  // Field-rep registry. Deactivate on departure; never hard-delete (historical FK).
  await db`
    create table if not exists salespeople (
      id           bigserial primary key,
      full_name    text not null,
      code         text unique,
      phone_e164   text,
      default_area text,
      active       boolean not null default true,
      created_at   timestamptz not null default now()
    )
  `;
  // Additive: if table existed before `active` was introduced, add it now.
  await db`alter table salespeople add column if not exists active boolean not null default true`;

  // Customer master: enables New/Old auto-detection + dedup.
  await db`
    create table if not exists customers (
      id            bigserial primary key,
      store_name    text not null,
      category      text not null,
      area          text,
      address       text,
      postal_code   text,
      first_seen_at timestamptz,
      created_by    bigint references salespeople(id)
    )
  `;
  await db`
    create unique index if not exists customers_norm
      on customers (lower(trim(store_name)), coalesce(area, ''))
  `;

  // The visit log. visited_at is server-stamped on submit; immutable to reps.
  await db`
    create table if not exists visits (
      id             bigserial primary key,
      salesperson_id bigint not null references salespeople(id),
      customer_id    bigint references customers(id),
      pic_name       text,
      store_name     text not null,
      customer_type  text not null check (customer_type in ('new','old')),
      category       text not null,
      address        text,
      area           text not null,
      postal_code    text check (postal_code is null or postal_code ~ '^\\d{5}$'),
      notes          text,
      visited_at     timestamptz not null default now(),
      created_at     timestamptz not null default now(),
      source         text not null default 'app'
    )
  `;
  await db`create index if not exists visits_rep_time on visits (salesperson_id, visited_at desc)`;
  await db`create index if not exists visits_area     on visits (area)`;
  await db`create index if not exists visits_type     on visits (customer_type)`;
  await db`alter table visits add column if not exists activity_type text not null default 'kunjungan'`;

  // Audit log for Handler overrides of visited_at.
  await db`
    create table if not exists visit_audits (
      id         bigserial primary key,
      visit_id   bigint not null references visits(id),
      field      text not null,
      old_value  text,
      new_value  text,
      changed_by text,
      changed_at timestamptz not null default now()
    )
  `;

  // Photo attachments — up to 5 per visit, stored as bytea.
  await db`
    create table if not exists visit_photos (
      id         bigserial primary key,
      visit_id   bigint not null references visits(id) on delete cascade,
      file_data  bytea not null,
      mime_type  text not null default 'image/jpeg',
      filename   text,
      file_size  int not null,
      created_at timestamptz not null default now()
    )
  `;
  await db`create index if not exists visit_photos_visit_idx on visit_photos (visit_id)`;

  // ── Module D — Accounts (customers enhancement + pipeline tables) ──────────

  // Enhance customers table with account pipeline columns.
  await db`alter table customers add column if not exists account_type   text default 'repeating'`;
  await db`alter table customers add column if not exists stage          text default 'aktif'`;
  await db`alter table customers add column if not exists owner_id       bigint references salespeople(id)`;
  await db`alter table customers add column if not exists last_contact_at timestamptz`;

  // Backfill owner_id + last_contact_at from visits for accounts that pre-date Module D.
  await db`
    update customers c
    set
      owner_id        = coalesce(c.owner_id,        v.salesperson_id),
      last_contact_at = coalesce(c.last_contact_at, v.visited_at)
    from (
      select distinct on (customer_id)
        customer_id, salesperson_id, visited_at
      from visits
      where customer_id is not null
      order by customer_id, visited_at desc
    ) v
    where c.id = v.customer_id
      and (c.owner_id is null or c.last_contact_at is null)
  `;

  // Every touchpoint (visit, call, order) linked to an account.
  await db`
    create table if not exists actions (
      id             bigserial primary key,
      account_id     bigint not null references customers(id),
      salesperson_id bigint references salespeople(id),
      action_type    text not null,
      invoice_number text,
      notes          text,
      actioned_at    timestamptz not null default now(),
      created_at     timestamptz not null default now()
    )
  `;
  await db`create index if not exists actions_account_idx on actions (account_id, actioned_at desc)`;
  await db`create index if not exists actions_rep_idx     on actions (salesperson_id, actioned_at desc)`;

  // Audit trail for stage transitions.
  await db`
    create table if not exists stage_history (
      id          bigserial primary key,
      account_id  bigint not null references customers(id),
      old_stage   text,
      new_stage   text not null,
      changed_by  bigint references salespeople(id),
      changed_at  timestamptz not null default now()
    )
  `;
  await db`create index if not exists stage_history_account_idx on stage_history (account_id, changed_at desc)`;

  // Scheduled follow-up actions.
  await db`
    create table if not exists scheduled_actions (
      id             bigserial primary key,
      account_id     bigint not null references customers(id),
      salesperson_id bigint references salespeople(id),
      action_type    text not null default 'followup',
      scheduled_for  timestamptz not null,
      notes          text,
      completed_at   timestamptz,
      created_at     timestamptz not null default now()
    )
  `;
  await db`create index if not exists scheduled_actions_rep_idx  on scheduled_actions (salesperson_id, scheduled_for)`;
  await db`create index if not exists scheduled_actions_acct_idx on scheduled_actions (account_id, scheduled_for)`;

  // Escalation table — leads the rep cannot visit; sourced by eskalasi team.
  await db`
    create table if not exists escalations (
      id                     bigserial primary key,
      salesperson_id         bigint not null references salespeople(id),
      store_name             text not null,
      category               text,
      area                   text,
      address                text,
      notes                  text,
      status                 text not null default 'pending',
      resolved_contact_name  text,
      resolved_contact_phone text,
      resolved_notes         text,
      resolved_at            timestamptz,
      resolved_by            text,
      followed_up_at         timestamptz,
      created_at             timestamptz not null default now()
    )
  `;
  await db`create index if not exists escalations_rep_idx    on escalations (salesperson_id, created_at desc)`;
  await db`create index if not exists escalations_status_idx on escalations (status, created_at desc)`;

  // Normalize area to Title Case + upgrade unique index to be case-insensitive on area.
  // Step 1: merge duplicate customers that differ only by area casing (keep lowest id, re-point FKs).
  await db`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY lower(trim(store_name)), lower(coalesce(area,''))
          ORDER BY id ASC
        ) AS keep_id
      FROM customers
    ),
    dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
    UPDATE visits     SET customer_id = dupes.keep_id FROM dupes WHERE visits.customer_id     = dupes.id
  `;
  await db`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY lower(trim(store_name)), lower(coalesce(area,''))
          ORDER BY id ASC
        ) AS keep_id
      FROM customers
    ),
    dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
    UPDATE actions    SET account_id = dupes.keep_id FROM dupes WHERE actions.account_id    = dupes.id
  `;
  await db`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY lower(trim(store_name)), lower(coalesce(area,''))
          ORDER BY id ASC
        ) AS keep_id
      FROM customers
    ),
    dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
    UPDATE stage_history SET account_id = dupes.keep_id FROM dupes WHERE stage_history.account_id = dupes.id
  `;
  await db`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY lower(trim(store_name)), lower(coalesce(area,''))
          ORDER BY id ASC
        ) AS keep_id
      FROM customers
    ),
    dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
    UPDATE scheduled_actions SET account_id = dupes.keep_id FROM dupes WHERE scheduled_actions.account_id = dupes.id
  `;
  await db`
    WITH ranked AS (
      SELECT id,
        FIRST_VALUE(id) OVER (
          PARTITION BY lower(trim(store_name)), lower(coalesce(area,''))
          ORDER BY id ASC
        ) AS keep_id
      FROM customers
    ),
    dupes AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
    DELETE FROM customers WHERE id IN (SELECT id FROM dupes)
  `;
  // Step 2: normalize area to Title Case on remaining rows.
  await db`UPDATE visits    SET area = initcap(lower(area)) WHERE area IS NOT NULL AND area <> initcap(lower(area))`;
  await db`UPDATE customers SET area = initcap(lower(area)) WHERE area IS NOT NULL AND area <> initcap(lower(area))`;
  // Step 3: upgrade unique index to lower(coalesce(area,'')) so casing can never split again.
  await db`DROP INDEX IF EXISTS customers_norm`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS customers_norm ON customers (lower(trim(store_name)), lower(coalesce(area, '')))`;

  // Seed categories + areas — wrapped so a missing visit_lists table never
  // prevents the salespeople seeding below from running.
  try {
    for (const v of ["Toko", "Workshop", "Aplikator", "Kontraktor", "Distributor", "Advertising/Signage", "Project", "Other"]) {
      await db`insert into visit_lists (type, value) values ('category', ${v}) on conflict do nothing`;
    }
    for (const v of [
      "Bekasi Barat", "Bekasi Timur", "Bekasi Utara", "Bekasi Selatan", "Bekasi Kota",
      "Cikarang", "Karawang", "Depok", "Tangerang Selatan",
      "Jakarta Timur", "Jakarta Selatan", "Jakarta Pusat", "Jakarta Barat", "Jakarta Utara",
      "Bogor",
    ]) {
      await db`insert into visit_lists (type, value) values ('area', ${v}) on conflict do nothing`;
    }
  } catch (listSeedErr) {
    console.error("[migrate] visit_lists seeding failed (non-fatal):", listSeedErr);
  }

  // ── Retail location-typo merge ───────────────────────────────────────────
  // Planned from the real production area values. Only these exact hand-typed
  // variants are merged onto their canonical area; every other area is left
  // untouched. Idempotent; logged. Visits update directly (no constraint);
  // customers only rename when it won't collide with an existing
  // (store_name, canonical-area) row — any collision is left in place and
  // reported for manual review rather than deleting a row.
  try {
    const RETAIL_AREA_FIXES: [string, string][] = [
      ["Bekasi.", "Bekasi"],
      ["Jaktim", "Jakarta Timur"],
      ["Tabgerang", "Tangerang"],
      ["Tangsel", "Tangerang Selatan"],
    ];
    for (const [from, to] of RETAIL_AREA_FIXES) {
      const v = await db`update visits set area = ${to} where area = ${from}`;
      const c = await db`
        update customers set area = ${to}
        where area = ${from}
          and not exists (
            select 1 from customers c2
            where lower(trim(c2.store_name)) = lower(trim(customers.store_name)) and c2.area = ${to}
          )`;
      const stuck = await db<{ id: number }[]>`select id from customers where area = ${from}`;
      if (v.count || c.count || stuck.length) {
        console.info(`[migrate] retail area merge: "${from}" -> "${to}" ` +
          `(${v.count} visits, ${c.count} customers` +
          `${stuck.length ? `; ${stuck.length} customer(s) left — dup store already in "${to}"` : ""})`);
      }
    }
  } catch (areaErr) {
    console.error("[migrate] retail area merge failed (non-fatal):", areaErr);
  }

  // Seed initial roster (inferred from workbook tabs). Handler can extend.
  try {
    for (const r of [
      { full_name: "Hanif",    code: "HNF" },
      { full_name: "Edhy",     code: "EDH" },
      { full_name: "Suwondo",  code: "SWD" },
      { full_name: "Rahmanto", code: "RHM" },
      { full_name: "Burhan",   code: "BRH" },
      { full_name: "Anthony",  code: "ANT" },
      { full_name: "Koni",     code: "KNI" },
    ]) {
      await db`
        insert into salespeople (full_name, code)
        values (${r.full_name}, ${r.code})
        on conflict (code) do nothing
      `;
    }
    // Deactivate project-team reps that were mistakenly seeded into the retail table
    await db`
      update salespeople set active = false
      where code in ('DSY','FBI','YNI','HVI','YPI','ALI','RAF','DVA')
    `;
  } catch (seedErr) {
    console.error("[migrate] salespeople seeding failed (non-fatal):", seedErr);
  }

  // ── Module E — Custom Color Gateway ──────────────────────────────────────────
  try {
    await db`
      create table if not exists color_requests (
        id                  serial primary key,
        request_no          text not null unique,
        status              text not null default 'DIAJUKAN'
                            check (status in ('DIAJUKAN','DIPROSES','SIAP','SELESAI','DIBATALKAN','DITOLAK')),
        sales_rep_id        bigint not null references salespeople(id),
        customer_name       text not null,
        project_name        text,
        product_line        text not null check (product_line in ('MACO','ALCOPAN','TAJIMA','SAKURA')),
        coating_type        text not null check (coating_type in ('PVDF','PE')),
        color_name          text not null,
        color_code          text,
        color_reference     text not null check (color_reference in ('KODE_RAL','NCS','PANTONE','SAMPEL_FISIK','FOTO')),
        qty_panels          int not null default 1 check (qty_panels between 1 and 10),
        needed_by           date,
        notes               text,
        route               text check (route in ('LOKAL','INTERNASIONAL')),
        eta_date            date,
        vendor_name         text,
        routing_note        text,
        routed_at           timestamptz,
        routed_by           text,
        ready_at            timestamptz,
        storage_location    text,
        fulfillment_mode    text check (fulfillment_mode in ('AMBIL','KIRIM')),
        delivery_recipient  text,
        delivery_phone      text,
        delivery_address    text,
        fulfilled_at        timestamptz,
        reject_reason       text,
        cancelled_at        timestamptz,
        created_at          timestamptz not null default now(),
        updated_at          timestamptz not null default now()
      )
    `;
    await db`create index if not exists idx_color_requests_status on color_requests(status)`;
    await db`create index if not exists idx_color_requests_rep    on color_requests(sales_rep_id)`;
    await db`create index if not exists idx_color_requests_eta    on color_requests(eta_date) where status = 'DIPROSES'`;

    await db`
      create table if not exists color_request_events (
        id           serial primary key,
        request_id   int not null references color_requests(id),
        from_status  text,
        to_status    text not null,
        actor        text not null,
        note         text,
        created_at   timestamptz not null default now()
      )
    `;
    await db`create index if not exists idx_cre_request on color_request_events(request_id)`;

    await db`
      create table if not exists color_request_counters (
        year    int primary key,
        last_no int not null default 0
      )
    `;

    // chk_kirim_fields: no "add constraint if not exists" in PG — swallow duplicate_object.
    try {
      await db`
        alter table color_requests add constraint chk_kirim_fields
        check (
          fulfillment_mode is distinct from 'KIRIM'
          or (delivery_recipient is not null and delivery_phone is not null and delivery_address is not null)
        )
      `;
    } catch (constraintErr: unknown) {
      if (!String((constraintErr as Error)?.message ?? "").includes("already exists")) throw constraintErr;
    }
  } catch (eErr) {
    console.error("[migrate] Module E color gateway migration failed (non-fatal):", eErr);
  }

  // ── Mirae Module — isolated visitation log ──────────────────────────────────
  try {
    await db`
      create table if not exists mirae_salespeople (
        id           bigserial primary key,
        full_name    text not null,
        code         text unique,
        active       boolean not null default true,
        created_at   timestamptz not null default now()
      )
    `;
    await db`
      create table if not exists mirae_visit_lists (
        id     bigserial primary key,
        type   text not null,
        value  text not null,
        active boolean not null default true
      )
    `;
    await db`
      create unique index if not exists mirae_visit_lists_type_value_idx
        on mirae_visit_lists (type, lower(value))
    `;
    await db`
      create table if not exists mirae_customers (
        id            bigserial primary key,
        store_name    text not null,
        category      text not null,
        area          text,
        address       text,
        postal_code   text,
        first_seen_at timestamptz,
        created_by    bigint references mirae_salespeople(id)
      )
    `;
    await db`
      create unique index if not exists mirae_customers_norm
        on mirae_customers (lower(trim(store_name)), lower(coalesce(area, '')))
    `;
    await db`
      create table if not exists mirae_visits (
        id             bigserial primary key,
        salesperson_id bigint not null references mirae_salespeople(id),
        customer_id    bigint references mirae_customers(id),
        pic_name       text,
        store_name     text not null,
        customer_type  text not null check (customer_type in ('new','old')),
        category       text not null,
        address        text,
        area           text not null,
        postal_code    text check (postal_code is null or postal_code ~ '^\\d{5}$'),
        notes          text,
        visited_at     timestamptz not null default now(),
        created_at     timestamptz not null default now(),
        activity_type  text not null default 'kunjungan',
        source         text not null default 'app'
      )
    `;
    await db`create index if not exists mirae_visits_rep_time on mirae_visits (salesperson_id, visited_at desc)`;
    await db`create index if not exists mirae_visits_area     on mirae_visits (area)`;
    await db`create index if not exists mirae_visits_type     on mirae_visits (customer_type)`;
    await db`alter table mirae_visits add column if not exists phone text`;
    await db`alter table mirae_customers add column if not exists status text not null default 'aktif'`;
    await db`
      create table if not exists mirae_visit_photos (
        id         bigserial primary key,
        visit_id   bigint not null references mirae_visits(id) on delete cascade,
        file_data  bytea not null,
        mime_type  text not null default 'image/jpeg',
        filename   text,
        file_size  int not null,
        created_at timestamptz not null default now()
      )
    `;
    await db`create index if not exists mirae_visit_photos_visit_idx on mirae_visit_photos (visit_id)`;
    await db`
      create table if not exists mirae_visit_audits (
        id         bigserial primary key,
        visit_id   bigint not null references mirae_visits(id),
        field      text not null,
        old_value  text,
        new_value  text,
        changed_by text,
        changed_at timestamptz not null default now()
      )
    `;

    // Seed categories + areas. Canonical Mirae categories are the seven the team
    // uses; "Other" is kept only as a fallback bucket (not a dropdown choice).
    for (const v of ["Toko", "Workshop", "Aplikator", "Kontraktor", "Architect", "Designer", "Project", "Other"]) {
      await db`insert into mirae_visit_lists (type, value) values ('category', ${v}) on conflict do nothing`;
    }
    // Only the seven real categories are selectable; deactivate legacy / off-list
    // values (Distributor, Advertising/Signage, Arsitek, Other, …).
    await db`
      update mirae_visit_lists set active = (
        lower(value) in ('toko','workshop','aplikator','kontraktor','architect','designer','project')
      )
      where type = 'category'
    `;
    for (const v of [
      "Bekasi Barat", "Bekasi Timur", "Bekasi Utara", "Bekasi Selatan", "Bekasi Kota",
      "Cikarang", "Karawang", "Depok", "Tangerang Selatan",
      "Jakarta Timur", "Jakarta Selatan", "Jakarta Pusat", "Jakarta Barat", "Jakarta Utara",
      "Bogor",
    ]) {
      await db`insert into mirae_visit_lists (type, value) values ('area', ${v}) on conflict do nothing`;
    }

    // ── One-time recovery of the architect / designer segment ────────────────
    // A prior cleanup collapsed these into "Other" and overwrote the original
    // category text, so it can't be normalized back from the category column.
    // The firm's store_name still identifies it, so rebuild from that. Idempotent
    // (only touches rows still sitting in 'Other'); fully logged.
    const archMatch = db`(
      store_name ilike '%architect%' or store_name ilike '%architec%' or
      store_name ilike '%arrchitect%' or store_name ilike '%arsitek%' or
      store_name ilike '%studio%'    or store_name ilike '%atelier%'  or
      store_name ilike '%assosiate%' or store_name ilike '%associate%')`;
    const dsgnMatch = db`(
      store_name ilike '%interior%'  or store_name ilike '%designer%' or
      store_name ilike '%desain%'    or store_name ilike '%creative%')`;

    const cArch = await db`update mirae_customers set category = 'Architect' where category = 'Other' and ${archMatch}`;
    const cDsgn = await db`update mirae_customers set category = 'Designer'  where category = 'Other' and ${dsgnMatch}`;
    // Visits: prefer the now-corrected linked customer's category; fall back to
    // the visit's own store_name for any unlinked rows.
    const vLink = await db`
      update mirae_visits v set category = c.category
      from mirae_customers c
      where v.customer_id = c.id and v.category = 'Other' and c.category <> 'Other'`;
    const vArch = await db`update mirae_visits set category = 'Architect' where category = 'Other' and ${archMatch}`;
    const vDsgn = await db`update mirae_visits set category = 'Designer'  where category = 'Other' and ${dsgnMatch}`;
    console.info(`[migrate] mirae recovery — customers: +${cArch.count} Architect, +${cDsgn.count} Designer; ` +
      `visits: ${vLink.count} via customer link, +${vArch.count} Architect, +${vDsgn.count} Designer`);

    // Safety net: normalize any remaining raw category text (e.g. future imports)
    // onto the canonical set. No-op for already-canonical rows.
    for (const table of ["mirae_visits", "mirae_customers"] as const) {
      const rows = await db<{ category: string; n: string }[]>`
        select category, count(*)::text as n from ${db(table)}
        where category is not null group by category
      `;
      for (const { category } of rows) {
        const canon = normalizeMiraeCategory(category);
        if (canon !== category) {
          await db`update ${db(table)} set category = ${canon} where category = ${category}`;
        }
      }
    }

    // Log the final state so the cleanup is auditable, incl. any customers still
    // in "Other" (their store_name didn't identify a category — need manual review).
    {
      const vcat = await db`select category, count(*)::int n from mirae_visits group by category order by n desc`;
      const stillOther = await db`select id, store_name from mirae_customers where category = 'Other' order by store_name`;
      console.info("[migrate] mirae final visit categories: " + JSON.stringify(vcat));
      console.info("[migrate] mirae customers still in Other (manual review): " + JSON.stringify(stillOther));
    }

    // Seed Mirae salespeople
    for (const r of [
      { full_name: "Brilliano", code: "BRL" },
      { full_name: "Bayu",      code: "BYU" },
      { full_name: "Sarah",     code: "SRH" },
    ]) {
      await db`
        insert into mirae_salespeople (full_name, code)
        values (${r.full_name}, ${r.code})
        on conflict (code) do nothing
      `;
    }
  } catch (miraeErr) {
    console.error("[migrate] Mirae module migration failed (non-fatal):", miraeErr);
  }

  // ── Project Module — isolated visitation log ──────────────────────────────
  try {
    await db`
      create table if not exists project_salespeople (
        id           bigserial primary key,
        full_name    text not null,
        code         text unique,
        active       boolean not null default true,
        created_at   timestamptz not null default now()
      )
    `;
    await db`
      create table if not exists project_visit_lists (
        id     bigserial primary key,
        type   text not null,
        value  text not null,
        active boolean not null default true
      )
    `;
    await db`
      create unique index if not exists project_visit_lists_type_value_idx
        on project_visit_lists (type, lower(value))
    `;
    await db`
      create table if not exists project_customers (
        id            bigserial primary key,
        store_name    text not null,
        category      text not null,
        area          text,
        address       text,
        postal_code   text,
        first_seen_at timestamptz,
        created_by    bigint references project_salespeople(id)
      )
    `;
    await db`
      create unique index if not exists project_customers_norm
        on project_customers (lower(trim(store_name)), lower(coalesce(area, '')))
    `;
    await db`
      create table if not exists project_visits (
        id             bigserial primary key,
        salesperson_id bigint not null references project_salespeople(id),
        customer_id    bigint references project_customers(id),
        pic_name       text,
        store_name     text not null,
        customer_type  text not null check (customer_type in ('new','old')),
        category       text not null,
        address        text,
        area           text not null,
        postal_code    text check (postal_code is null or postal_code ~ '^\\d{5}$'),
        notes          text,
        visited_at     timestamptz not null default now(),
        created_at     timestamptz not null default now(),
        activity_type  text not null default 'kunjungan',
        source         text not null default 'app'
      )
    `;
    await db`create index if not exists project_visits_rep_time on project_visits (salesperson_id, visited_at desc)`;
    await db`create index if not exists project_visits_area     on project_visits (area)`;
    await db`create index if not exists project_visits_type     on project_visits (customer_type)`;
    await db`
      create table if not exists project_visit_photos (
        id         bigserial primary key,
        visit_id   bigint not null references project_visits(id) on delete cascade,
        file_data  bytea not null,
        mime_type  text not null default 'image/jpeg',
        filename   text,
        file_size  int not null,
        created_at timestamptz not null default now()
      )
    `;
    await db`create index if not exists project_visit_photos_visit_idx on project_visit_photos (visit_id)`;
    await db`
      create table if not exists project_visit_audits (
        id         bigserial primary key,
        visit_id   bigint not null references project_visits(id),
        field      text not null,
        old_value  text,
        new_value  text,
        changed_by text,
        changed_at timestamptz not null default now()
      )
    `;

    // Persisted health cadence (same system as Module D's `customers` table —
    // see accounts.ts's startCadenceEngine / startProjectCadenceEngine).
    // Display always derives health live from last_contact_at; these columns
    // exist so bulk reads/exports and the stage_history audit trail don't
    // need a live computation, and stay in sync via the hourly cadence job.
    await db`alter table project_customers add column if not exists stage          text default 'aktif'`;
    await db`alter table project_customers add column if not exists last_contact_at timestamptz`;

    // Backfill last_contact_at from visit history for rows that pre-date these columns.
    await db`
      update project_customers c
      set last_contact_at = v.last_visited_at
      from (
        select customer_id, max(visited_at) as last_visited_at
        from project_visits
        where customer_id is not null
        group by customer_id
      ) v
      where c.id = v.customer_id
        and c.last_contact_at is null
    `;

    await db`
      create table if not exists project_stage_history (
        id          bigserial primary key,
        account_id  bigint not null references project_customers(id),
        old_stage   text,
        new_stage   text not null,
        changed_by  bigint references project_salespeople(id),
        changed_at  timestamptz not null default now()
      )
    `;
    await db`create index if not exists project_stage_history_account_idx on project_stage_history (account_id, changed_at desc)`;

    // Seed categories + areas (Project-specific)
    for (const v of ["Project", "HO", "Aplikator", "Arsitek", "Design & Build", "Build Contractor"]) {
      await db`insert into project_visit_lists (type, value) values ('category', ${v}) on conflict do nothing`;
    }
    // Deactivate categories not in the project-team list (including old Kontraktor)
    await db`
      update project_visit_lists set active = false
      where type = 'category'
        and lower(value) not in ('project','ho','aplikator','arsitek','design & build','build contractor')
    `;
    for (const v of [
      "Bekasi Barat", "Bekasi Timur", "Bekasi Utara", "Bekasi Selatan", "Bekasi Kota",
      "Cikarang", "Karawang", "Depok", "Tangerang Selatan",
      "Jakarta Timur", "Jakarta Selatan", "Jakarta Pusat", "Jakarta Barat", "Jakarta Utara",
      "Bogor",
    ]) {
      await db`insert into project_visit_lists (type, value) values ('area', ${v}) on conflict do nothing`;
    }

    // Backfill: canonicalize free-text categories so the insights heatmap groups
    // cleanly. Reps typed these by hand ("HO"/"ho", "Project JAC Blibli Tower",
    // "Cafe"), which fragments a single bucket into many. Map each distinct value
    // onto the canonical set; off-list values fall back to "Project".
    for (const table of ["project_visits", "project_customers"] as const) {
      const rows = await db<{ category: string }[]>`
        select distinct category from ${db(table)} where category is not null
      `;
      for (const { category } of rows) {
        const canon = normalizeProjectCategory(category);
        if (canon !== category) {
          await db`update ${db(table)} set category = ${canon} where category = ${category}`;
        }
      }
    }

    // Seed Project salespeople
    for (const r of [
      { full_name: "Ali",   code: "ALI" },
      { full_name: "Dava",  code: "DVA" },
      { full_name: "Deasy", code: "DSY" },
      { full_name: "Febi",  code: "FBI" },
      { full_name: "Havi",  code: "HVI" },
      { full_name: "Raafi", code: "RAF" },
      { full_name: "Yeni",  code: "YNI" },
      { full_name: "Yupi",  code: "YPI" },
      { full_name: "Biya",  code: "BIY" },
    ]) {
      await db`
        insert into project_salespeople (full_name, code)
        values (${r.full_name}, ${r.code})
        on conflict (code) do nothing
      `;
    }
  } catch (projectErr) {
    console.error("[migrate] Project module migration failed (non-fatal):", projectErr);
  }

  // ── Distributor Module — full clone of Module D (Retail Visitation Log) ────
  // Same shape as retail: pipeline accounts, actions, stage history, scheduled
  // follow-ups, escalations, cadence engine. Isolated distributor_* tables.
  try {
    await db`
      create table if not exists distributor_visit_lists (
        id     bigserial primary key,
        type   text not null,
        value  text not null,
        active boolean not null default true
      )
    `;
    await db`
      create unique index if not exists distributor_visit_lists_type_value_idx
        on distributor_visit_lists (type, lower(value))
    `;
    await db`
      create table if not exists distributor_salespeople (
        id           bigserial primary key,
        full_name    text not null,
        code         text unique,
        phone_e164   text,
        default_area text,
        active       boolean not null default true,
        created_at   timestamptz not null default now()
      )
    `;
    await db`
      create table if not exists distributor_customers (
        id              bigserial primary key,
        store_name      text not null,
        category        text not null,
        area            text,
        address         text,
        postal_code     text,
        first_seen_at   timestamptz,
        created_by      bigint references distributor_salespeople(id),
        account_type    text default 'repeating',
        stage           text default 'aktif',
        owner_id        bigint references distributor_salespeople(id),
        last_contact_at timestamptz
      )
    `;
    await db`
      create unique index if not exists distributor_customers_norm
        on distributor_customers (lower(trim(store_name)), lower(coalesce(area, '')))
    `;
    await db`
      create table if not exists distributor_visits (
        id             bigserial primary key,
        salesperson_id bigint not null references distributor_salespeople(id),
        customer_id    bigint references distributor_customers(id),
        pic_name       text,
        store_name     text not null,
        customer_type  text not null check (customer_type in ('new','old')),
        category       text not null,
        address        text,
        area           text not null,
        postal_code    text check (postal_code is null or postal_code ~ '^\\d{5}$'),
        notes          text,
        activity_type  text not null default 'kunjungan',
        visited_at     timestamptz not null default now(),
        created_at     timestamptz not null default now(),
        source         text not null default 'app'
      )
    `;
    await db`create index if not exists distributor_visits_rep_time on distributor_visits (salesperson_id, visited_at desc)`;
    await db`create index if not exists distributor_visits_area     on distributor_visits (area)`;
    await db`create index if not exists distributor_visits_type     on distributor_visits (customer_type)`;
    await db`
      create table if not exists distributor_visit_audits (
        id         bigserial primary key,
        visit_id   bigint not null references distributor_visits(id),
        field      text not null,
        old_value  text,
        new_value  text,
        changed_by text,
        changed_at timestamptz not null default now()
      )
    `;
    await db`
      create table if not exists distributor_visit_photos (
        id         bigserial primary key,
        visit_id   bigint not null references distributor_visits(id) on delete cascade,
        file_data  bytea not null,
        mime_type  text not null default 'image/jpeg',
        filename   text,
        file_size  int not null,
        created_at timestamptz not null default now()
      )
    `;
    await db`create index if not exists distributor_visit_photos_visit_idx on distributor_visit_photos (visit_id)`;
    await db`
      create table if not exists distributor_actions (
        id             bigserial primary key,
        account_id     bigint not null references distributor_customers(id),
        salesperson_id bigint references distributor_salespeople(id),
        action_type    text not null,
        invoice_number text,
        notes          text,
        actioned_at    timestamptz not null default now(),
        created_at     timestamptz not null default now()
      )
    `;
    await db`create index if not exists distributor_actions_account_idx on distributor_actions (account_id, actioned_at desc)`;
    await db`create index if not exists distributor_actions_rep_idx     on distributor_actions (salesperson_id, actioned_at desc)`;
    await db`
      create table if not exists distributor_stage_history (
        id          bigserial primary key,
        account_id  bigint not null references distributor_customers(id),
        old_stage   text,
        new_stage   text not null,
        changed_by  bigint references distributor_salespeople(id),
        changed_at  timestamptz not null default now()
      )
    `;
    await db`create index if not exists distributor_stage_history_account_idx on distributor_stage_history (account_id, changed_at desc)`;
    await db`
      create table if not exists distributor_scheduled_actions (
        id             bigserial primary key,
        account_id     bigint not null references distributor_customers(id),
        salesperson_id bigint references distributor_salespeople(id),
        action_type    text not null default 'followup',
        scheduled_for  timestamptz not null,
        notes          text,
        completed_at   timestamptz,
        created_at     timestamptz not null default now()
      )
    `;
    await db`create index if not exists distributor_scheduled_actions_rep_idx  on distributor_scheduled_actions (salesperson_id, scheduled_for)`;
    await db`create index if not exists distributor_scheduled_actions_acct_idx on distributor_scheduled_actions (account_id, scheduled_for)`;
    await db`
      create table if not exists distributor_escalations (
        id                     bigserial primary key,
        salesperson_id         bigint not null references distributor_salespeople(id),
        store_name             text not null,
        category               text,
        area                   text,
        address                text,
        notes                  text,
        status                 text not null default 'pending',
        resolved_contact_name  text,
        resolved_contact_phone text,
        resolved_notes         text,
        resolved_at            timestamptz,
        resolved_by            text,
        followed_up_at         timestamptz,
        created_at             timestamptz not null default now()
      )
    `;
    await db`create index if not exists distributor_escalations_rep_idx    on distributor_escalations (salesperson_id, created_at desc)`;
    await db`create index if not exists distributor_escalations_status_idx on distributor_escalations (status, created_at desc)`;

    // Seed categories + areas (clone of the retail starter set).
    for (const v of ["Toko", "Workshop", "Aplikator", "Kontraktor", "Distributor", "Advertising/Signage", "Project", "Other"]) {
      await db`insert into distributor_visit_lists (type, value) values ('category', ${v}) on conflict do nothing`;
    }
    for (const v of [
      "Bekasi Barat", "Bekasi Timur", "Bekasi Utara", "Bekasi Selatan", "Bekasi Kota",
      "Cikarang", "Karawang", "Depok", "Tangerang Selatan",
      "Jakarta Timur", "Jakarta Selatan", "Jakarta Pusat", "Jakarta Barat", "Jakarta Utara",
      "Bogor",
    ]) {
      await db`insert into distributor_visit_lists (type, value) values ('area', ${v}) on conflict do nothing`;
    }
    // Roster starts empty — distributor reps are added via /distributor-salespeople.
  } catch (distributorErr) {
    console.error("[migrate] Distributor module migration failed (non-fatal):", distributorErr);
  }

  // ── SY Hunter Module — BCI factory/warehouse pipeline tracker ─────────────
  try {
    await db`
      create table if not exists sy_projects (
        id            bigserial primary key,
        rank          int,
        score         int,
        band          text,
        project_name  text not null,
        timing        text,
        fit           text,
        floor_area_m2 numeric,
        value_b_idr   numeric,
        province      text,
        town          text,
        stage         text,
        status        text,
        start_date    text,
        project_url   text,
        segment       text,
        is_captive    boolean not null default false,
        active        boolean not null default true,
        created_at    timestamptz not null default now()
      )
    `;
    await db`create unique index if not exists sy_projects_name_idx on sy_projects (lower(trim(project_name)))`;

    await db`
      create table if not exists sy_contacts (
        id           bigserial primary key,
        project_id   bigint references sy_projects(id),
        priority     text not null,
        band         text,
        score        int,
        company_name text,
        role         text,
        contact_name text,
        position     text,
        phone        text,
        email        text,
        project_name text,
        province     text,
        town         text,
        timing       text,
        source       text not null default 'hunter',
        active       boolean not null default true,
        created_at   timestamptz not null default now()
      )
    `;
    await db`create index if not exists sy_contacts_priority_idx on sy_contacts (priority, band, score desc nulls last)`;
    await db`create index if not exists sy_contacts_project_idx  on sy_contacts (project_id)`;

    await db`
      create table if not exists sy_pipeline (
        id            bigserial primary key,
        contact_id    bigint not null unique references sy_contacts(id),
        stage         text not null default 'fresh',
        note          text,
        meeting_at    timestamptz,
        called_at     timestamptz,
        interested_at timestamptz,
        updated_at    timestamptz not null default now()
      )
    `;
    await db`create index if not exists sy_pipeline_stage_idx on sy_pipeline (stage)`;

    // Rebuild — additive columns for 10-day dedup hunter/handler flow
    await db`alter table sy_contacts add column if not exists day         int`;
    await db`alter table sy_contacts add column if not exists phone_clean text`;
    await db`create index if not exists sy_contacts_day_idx on sy_contacts (day)`;

    await db`
      create table if not exists sy_outcomes (
        contact_id  bigint primary key references sy_contacts(id),
        status      text not null,
        note        text,
        updated_by  text,
        updated_at  timestamptz not null default now()
      )
    `;
    await db`create index if not exists sy_outcomes_status_idx  on sy_outcomes (status)`;
    await db`create index if not exists sy_outcomes_updated_idx on sy_outcomes (updated_at desc)`;
    await db`alter table sy_outcomes add column if not exists wa_number   text`;
    await db`alter table sy_outcomes add column if not exists pic_name    text`;
    await db`alter table sy_outcomes add column if not exists sample_sent boolean not null default false`;

    await db`alter table sy_pipeline add column if not exists messaged_at  timestamptz`;
    await db`alter table sy_pipeline add column if not exists replied_at   timestamptz`;
    await db`alter table sy_pipeline add column if not exists pipe_note    text`;
  } catch (syErr) {
    console.error("[migrate] SY Hunter migration failed (non-fatal):", syErr);
  }

  // ── SY Hunter data repair: dedup + day assignment ─────────────────────────
  // Runs when contacts exist but were seeded before the dedup/day rebuild.
  try {
    const repairCheck = await db`
      select
        count(*)::int                                    as total,
        count(*) filter (where day is not null)::int    as with_day
      from sy_contacts
    `;
    const { total, with_day } = repairCheck[0] ?? {};
    if (Number(total) > 0 && Number(with_day) === 0) {
      // 1. Normalize phone_clean for all rows
      await db`
        update sy_contacts
        set phone_clean = regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
        where phone_clean is null or phone_clean = ''
      `;

      // 2. Reset all to active, then mark lower-priority duplicate phones inactive
      await db`update sy_contacts set active = true`;
      await db`
        with ranked as (
          select id,
                 row_number() over (
                   partition by phone_clean
                   order by
                     case priority when 'P1' then 1 when 'P2' then 2 else 3 end,
                     case band when 'A' then 1 when 'B' then 2 else 3 end,
                     coalesce(score, 0) desc,
                     id
                 ) as rn
          from sy_contacts
          where phone_clean is not null and phone_clean <> ''
        )
        update sy_contacts set active = false
        where id in (select id from ranked where rn > 1)
      `;

      // 3. Assign day 1–10 across active contacts in priority order
      await db`
        with active_ordered as (
          select id,
                 row_number() over (
                   order by
                     case priority when 'P1' then 1 when 'P2' then 2 else 3 end,
                     case band when 'A' then 1 when 'B' then 2 else 3 end,
                     case
                       when timing like 'HOT%'  then 1
                       when timing like 'WARM%' then 2
                       when timing like 'COLD%' then 3
                       else 4
                     end,
                     coalesce(score, 0) desc,
                     id
                 ) as rn,
                 count(*) over () as total_active
          from sy_contacts
          where active = true
        )
        update sy_contacts c
        set day = least(10, ceil(o.rn::float / ceil(o.total_active::float / 10))::int)
        from active_ordered o
        where c.id = o.id
      `;
      console.info("[migrate] SY Hunter data repaired: dedup + day assignment applied");
    }
  } catch (repairErr) {
    console.error("[migrate] SY Hunter data repair failed (non-fatal):", repairErr);
  }
}

// Allow `tsx src/db/migrate.ts` as a one-off.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.ts")) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — nothing to migrate.");
    process.exit(1);
  }
  runMigrations(db)
    .then(() => {
      console.log("✓ migrations applied");
      return db.end();
    })
    .catch((err) => {
      console.error("migration failed:", err);
      process.exit(1);
    });
}
