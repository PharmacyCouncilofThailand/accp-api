# ACCP API

Backend API server with embedded database for ACCP Conference.

## Quick Start

```bash
npm install --legacy-peer-deps
npm run dev
```

## Available Scripts

| Command               | Description                          |
| --------------------- | ------------------------------------ |
| `npm run dev`         | Start development server (port 3002) |
| `npm run build`       | Build for production                 |
| `npm run start`       | Start production server              |
| `npm run db:generate` | Generate database migrations         |
| `npm run db:push`     | Push schema to database              |
| `npm run db:studio`   | Open Drizzle Studio                  |
| `npm run db:seed`     | Seed database with initial data      |

## Environment Variables

Copy `.env.example` to `.env` and update values:

```
DATABASE_URL=postgresql://user:password@localhost:5432/accp_db
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
```

## Project Structure

```
accp-api/
├── src/
│   ├── index.ts        # Main entry point
│   ├── database/       # Database schema & connection
│   ├── routes/         # API routes
│   ├── schemas/        # Zod validation schemas
│   └── services/       # Business logic
├── drizzle/            # Database migrations
└── package.json
```

## API Endpoints

- Health: `GET /health`
- Auth: `POST /auth/login`, `POST /auth/register`
- Backoffice: `/api/backoffice/*`
- Public: `/api/speakers`, `/api/abstracts`
