# ProofLayer

A verification API that turns **structured evidence** into a verdict. Instead of trusting a provider's claim ("this email was sent"), ProofLayer checks the evidence behind it and derives one of three results: `VERIFIED`, `FAILED` or `INCONCLUSIVE`, each with a confidence value.

The verdict rules are **deterministic**: no LLM and no randomness decide the outcome, so the same evidence always produces the same result.

## How a claim is evaluated

For an `email_sent` claim, the engine checks, in order:

| Rule | Result | Confidence |
| --- | --- | --- |
| Two sources disagree about the same check | `FAILED` (contradiction) | 0.75 |
| A required check failed (wrong recipient, subject, missing attachment, not sent) | `FAILED` | 0.90 |
| A required check is missing or unknown | `INCONCLUSIVE` | 0.50 |
| All required checks pass | `VERIFIED` | 0.98 |

An optional LLM-based semantic matcher exists for evidence comparison; the verdict itself never depends on it.

## Stack

| | |
| --- | --- |
| Runtime | Node.js 22, TypeScript |
| HTTP | Fastify 4 (CORS, helmet, rate limit, cookies, Swagger) |
| Database | PostgreSQL with Prisma 5 |
| Validation / logs | Zod, pino |
| Tests | Vitest |

## Features

- API keys and organization/agent management
- Gmail evidence provider with Google OAuth
- Deterministic verification engine
- Audit log of verification decisions
- Rate limiting, request IDs, encryption for stored secrets
- OpenAPI docs and a demo surface

## Run locally

```bash
cp .env.example .env
# Fill in ENCRYPTION_KEY, JWT_SECRET and the Google OAuth values

docker compose up -d      # PostgreSQL
npm install
npm run db:generate
npm run db:push
npm run dev
```

- API docs: <http://localhost:3000/docs> (when `SWAGGER_ENABLED=true`)
- Interactive demo: <http://localhost:3000/demo>
- Health check: <http://localhost:3000/health>

## Tests and build

```bash
npm test        # Vitest
npm run build   # tsc
npm run lint
```

## Configuration

See `.env.example` for every option. The important ones:

- `DATABASE_URL` — PostgreSQL connection string
- `ENCRYPTION_KEY` — at least 32 bytes (`openssl rand -base64 32`)
- `JWT_SECRET` — at least 32 characters
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — Gmail evidence
- `CORS_ALLOWED_ORIGINS` — exact production origins; takes precedence over `FRONTEND_URL`
- `SWAGGER_ENABLED=false` — turn off `/docs` and `/demo` in production

Do not deploy with the placeholder secrets from `.env.example`.

## License

No license file is included yet. Add one before asking others to reuse the code.
