# 🎯 Quick Start for AI Agents

> **Speed run:** Essential context to get started FAST

## What is this?
Self-hosted flaky test tracker. GitLab CI → Hono API → PostgreSQL → SvelteKit Dashboard.

## Tech Stack
- Hono + Drizzle ORM (API)
- SvelteKit + Tailwind + ECharts (Dashboard)
- PostgreSQL (Database)

## File You Need to Know First
1. `apps/api/src/db/schema.ts` - Database schema
2. `apps/api/src/services/flakiness.ts` - Core algorithm
3. `apps/api/src/routes/reports.ts` - Report ingestion
4. `apps/dashboard/src/routes/+layout.svelte` - Main UI

## Start Coding in 30 Seconds
```bash
docker compose up -d         # Start PostgreSQL
pnpm db:migrate              # Run migrations
pnpm dev                     # Start dev servers
```

**URLs:**
- API: http://localhost:8080
- Dashboard: http://localhost:5173

## Critical Rules
1. ✅ **ALWAYS** use `logger.error()`, not `console.error()`
2. ✅ **ALWAYS** add tests for new features
3. ✅ **ALWAYS** run `pnpm db:generate` after schema changes
4. ✅ **NEVER** construct raw SQL - use Drizzle query builder
5. ✅ Rate limiting already applied to routers - check before adding

## Common Tasks

### Add API Endpoint
```typescript
// apps/api/src/routes/YOUR_ROUTER.ts
router.get('/endpoint', async (c) => {
  // Query with Drizzle
  const data = await db.select().from(table);
  return c.json({ data });
});
```

### Add Database Column
```typescript
// 1. Edit apps/api/src/db/schema.ts
export const myTable = pgTable('my_table', {
  newColumn: varchar('new_column', { length: 100 }),
});

// 2. Generate + apply migration
pnpm db:generate
pnpm db:migrate
```

### Add Dashboard Page
```bash
# Create in apps/dashboard/src/routes/page-name/
+page.svelte        # UI
+page.server.ts     # Data loading
```

## Debugging
```bash
# API logs
docker compose logs -f api

# Test API
curl http://localhost:8080/api/v1/projects

# Database
docker compose exec postgres psql -U postgres -d flackyness
```

## Testing
```bash
pnpm test                    # All tests
pnpm --filter api test       # API only
```

## Project Status
- **Phase 1-6:** Complete ✅
- **Grade:** A- (92/100)
- **Production Ready:** Yes (with rate limiting, indexes, validation)

## Next Steps (Optional)
- Add admin endpoints (create/rotate tokens)
- Add Prometheus metrics
- Enable TypeScript strict mode

---

**For detailed info, see `.agent/CONTEXT.md`**
