# 🛡️ CodeGuard AI — Autonomous AI Code Reviewer & PR Bot

[![Next.js 16](https://img.shields.io/badge/Next.js-16.x-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Turborepo](https://img.shields.io/badge/Turborepo-Monorepo-ef4444?style=flat-square&logo=turborepo)](https://turbo.build/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-PostgreSQL-c084fc?style=flat-square)](https://orm.drizzle.team/)
[![Neon Postgres](https://img.shields.io/badge/Neon-pgvector-00e599?style=flat-square&logo=postgresql)](https://neon.tech/)
[![Clerk Auth](https://img.shields.io/badge/Clerk-GitHub_OAuth-6c47ff?style=flat-square&logo=clerk)](https://clerk.com/)
[![LLM Engine](https://img.shields.io/badge/LLM-Llama_3.3_70B-orange?style=flat-square&logo=meta)](https://groq.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

> **CodeGuard AI** is an enterprise-grade, event-driven autonomous AI code reviewer and GitHub Pull Request bot built with Next.js 16, Turborepo, Drizzle ORM, Neon PostgreSQL (pgvector), Clerk Auth, Llama 3.3 70B, and Octokit REST API.

---

## 💡 Overview

CodeGuard AI elevates static code analysis from a simple frontend LLM prompt box into a **production-ready developer tool** that seamlessly integrates into real-world software engineering workflows.

Instead of requiring developers to manually copy-paste code snippets into a website, CodeGuard AI acts as an **automated GitHub bot**:

- 🤖 **Webhook-Driven**: Triggers automated reviews instantly when a pull request is opened or updated on GitHub.
- ⚡ **Asynchronous Worker Queue**: Uses background queues to prevent HTTP request timeouts during long-running AI analysis tasks.
- 💬 **Line-Anchored GitHub Comments**: Automatically posts structured inline code suggestions directly onto GitHub PR files using Octokit REST API.
- 📊 **AI Observability & Telemetry**: Captures prompt versions, token consumption, model performance, and review duration.
- 🔁 **Fingerprint Deduplication**: Generates deterministic SHA256 hashes for findings to prevent comment spam across PR revisions.

---

## 🏗️ Architecture & Event-Driven Workflow

### High-Level System Architecture

```mermaid
graph TD
    subgraph GitHub ["Octokit & GitHub Platform"]
        PR["Developer Opens / Updates PR"]
        Webhook["GitHub Webhook Event"]
        Comments["Inline PR Review Comments"]
    end

    subgraph API ["Ingestion & Auth Layer"]
        NextAPI["Next.js App Router API (/api/webhooks/github)"]
        AuthGuard["Clerk Auth & Scoped Authorization"]
    end

    subgraph Queue ["Background Job Queue"]
        RedisQueue["BullMQ / Job Queue"]
        Worker["Async Review Worker"]
    end

    subgraph Pipeline ["AI Review & Analysis Engine"]
        DiffExtract["Octokit Diff Parser"]
        LLMEngine["Llama 3.3 70B / Groq Engine"]
        ZodValidator["Zod Output Validator"]
        Deduplicator["SHA256 Fingerprint Engine"]
    end

    subgraph Database ["Database & Persistence Layer"]
        NeonDB[("Neon PostgreSQL + pgvector")]
        DrizzleORM["Drizzle ORM"]
    end

    PR --> Webhook
    Webhook --> NextAPI
    AuthGuard --> NextAPI
    NextAPI --> RedisQueue
    RedisQueue --> Worker
    Worker --> DiffExtract
    DiffExtract --> LLMEngine
    LLMEngine --> ZodValidator
    ZodValidator --> Deduplicator
    Deduplicator --> DrizzleORM
    Deduplicator --> NeonDB
    Deduplicator --> Comments
```

---

## 🔄 Webhook PR Review Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant GH as GitHub Platform
    participant Webhook as CodeGuard Webhook Handler
    participant Queue as Redis / BullMQ Queue
    participant Worker as Background Worker
    participant LLM as Llama 3.3 70B Engine
    participant DB as Neon PostgreSQL DB

    Dev->>GH: Open / Update Pull Request
    GH->>Webhook: POST /api/webhooks/github (pull_request event)
    Webhook->>DB: Insert Review Record (status: pending)
    Webhook->>Queue: Enqueue Review Job { reviewId, prId, repoId }
    Webhook-->>GH: HTTP 202 Accepted (Immediate Response)
    
    Queue->>Worker: Consume Job
    Worker->>GH: Fetch PR Diff (Octokit REST)
    Worker->>LLM: Stream Diff & Prompt Context
    LLM-->>Worker: Structured Findings (JSON)
    Worker->>Worker: Validate Zod Schema & Fingerprint Issues
    Worker->>DB: Save Telemetry & Issues (status: completed)
    Worker->>GH: Post Line-Anchored Comments to PR
```

---

## ⭐ Production-Grade Engineering Pillars

### 1. ⚡ Asynchronous Background Processing
HTTP requests never block waiting for an LLM response. 
- **Immediate Response**: Webhook handlers respond with `HTTP 202 Accepted` within 100ms.
- **Worker Isolation**: Long-running diff extraction, AI inference, and comment posting happen in background worker threads.
- **Status State Machine**: Reviews transition reliably through state phases (`pending` $\rightarrow$ `completed` / `failed`).

### 2. 🤖 Webhook-Based Automatic Reviews
Seamless automated pull request checks triggered directly from GitHub:
- Listens for `pull_request.opened` and `pull_request.synchronize` events.
- Extracts changed files, unified diff patches, and additions/deletions.
- Direct inline comment integration on specific modified lines in GitHub PRs.

### 3. 📊 AI Observability & Performance Telemetry
Exposes critical operational metrics for monitoring AI behavior and cost:

```json
{
  "model": "llama-3.3-70b-versatile",
  "promptVersion": "v2.1",
  "durationMs": 12450,
  "filesReviewed": 7,
  "linesReviewed": 340,
  "issuesFound": 4,
  "tokenUsage": {
    "promptTokens": 1420,
    "completionTokens": 380,
    "totalTokens": 1800
  }
}
```

### 4. 🔁 Fingerprint-Based Comment Deduplication
Prevents re-posting identical comments when developers push new commits to an open PR:

$$\text{Issue Fingerprint} = \text{SHA256}(\text{repository} + \text{pr} + \text{file} + \text{line} + \text{category} + \text{issueHash})$$

- Checks existing issue fingerprints stored in Neon DB before posting.
- Skips duplicate issues automatically to keep PR code review threads clean.

### 5. 🛡️ API Hardening & Security
- **Strict Authorization Scoping**: Enforces tenant security (`review.userId === currentUser.id`).
- **Validation**: Runtime Zod schema enforcement on incoming API payloads and LLM outputs.
- **Line Accuracy Engine**: Matches AI issue line numbers against git patch chunk headers (`@@ -L,C +L,C @@`).

---

## 🛠️ Monorepo Tech Stack

| Domain | Technology | Description |
| :--- | :--- | :--- |
| **Monorepo** | **Turborepo** + **pnpm Workspaces** | High-performance build system and package management |
| **Frontend** | **Next.js 16 (App Router)** + **React 19** | Modern server/client architecture with Tailwind CSS |
| **Authentication** | **Clerk Auth** + **GitHub OAuth2** | Enterprise single sign-on and token delegation |
| **Database** | **Neon PostgreSQL** + **Drizzle ORM** | Serverless relational database with `pgvector` support |
| **AI Infrastructure** | **Llama 3.3 70B** via **Groq API** | High-speed, structured JSON schema code analysis |
| **GitHub REST API** | **Octokit Client (`octokit`)** | Repository, PR diff extraction, and comment creation |
| **Job Queue** | **BullMQ / Redis Worker** | Reliable background job execution |

---

## 📁 Repository Structure

```text
codeguard-ai/
├── apps/
│   ├── web/                         # Next.js 16 Web Dashboard & Webhook APIs
│   │   ├── src/app/
│   │   │   ├── api/
│   │   │   │   ├── github/          # PR list, diff extraction, comment endpoints
│   │   │   │   ├── review/          # Code review submission endpoint
│   │   │   │   ├── reviews/         # History & /reviews/[id] detail handlers
│   │   │   │   └── webhooks/        # GitHub webhook listener
│   │   │   └── reviews/[id]/        # Dynamic review analysis page
│   │   ├── src/components/          # PRReviewer & ReviewerDashboard components
│   │   └── src/lib/                 # Octokit helper & user synchronization
│   └── workers/                     # Asynchronous Job Consumer & Queue Processor
├── packages/
│   ├── db/                          # Drizzle ORM schemas (users, repos, prs, reviews)
│   ├── types/                       # Shared TypeScript interfaces & Zod schemas
│   └── config/                      # Environment & shared configuration
├── docker-compose.yml               # Local development Postgres & Redis
└── pnpm-workspace.yaml              # Monorepo workspaces definition
```

---

## 🚦 Roadmap & Engineering Milestones

- [x] **Phase 1: Foundation & Authentication**
  - Clerk GitHub OAuth authentication
  - Monorepo workspace configuration (Next.js 16 + Turborepo)
- [x] **Phase 2: Database & Core Review Engine**
  - Drizzle ORM integration with Neon PostgreSQL (`pgvector`)
  - Llama 3.3 70B AI review engine with structured Zod output
  - Dynamic Review Detail Dashboard (`/reviews/[id]`)
- [x] **Phase 3: GitHub PR Integration & Hardening**
  - Scoped user authorization & API error validation
  - GitHub repository & PR selection
  - Octokit PR diff extraction & inline comment creation
- [ ] **Phase 4: Webhooks & Async Workers (Active Milestone)**
  - GitHub Webhook endpoint (`POST /api/webhooks/github`)
  - BullMQ + Redis background job queue
- [ ] **Phase 5: Quality Controls & Deduplication**
  - AI Observability telemetry logging
  - SHA256 issue fingerprint deduplication engine
- [ ] **Phase 6: Testing & CI/CD**
  - Unit tests (diff parser, issue parser, fingerprinting)
  - Integration & E2E pipeline with GitHub Actions

---

## ⚡ Quick Start & Development Setup

### 1. Prerequisites
- **Node.js**: `v20.x` or higher
- **pnpm**: `v10.x` (`npm i -g pnpm`)
- **Docker**: (Optional, for local Redis/Postgres)

### 2. Installation
```bash
# Clone repository
git clone https://github.com/GOURAVSINGH19/Codeguard-Ai.git
cd Codeguard-Ai

# Install workspace dependencies
pnpm install
```

### 3. Environment Configuration
Create an `.env` file inside `apps/web/.env`:

```env
# Clerk Auth Keys
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Neon PostgreSQL Database
DATABASE_URL="postgresql://user:pass@ep-cool-db.neon.tech/neondb?sslmode=require"

# AI Engine Credentials
GROQ_API_KEY=gsk_...
GROQ_MODEL= ---

# GitHub App / Webhook Secret
GITHUB_WEBHOOK_SECRET=your_webhook_secret
```

### 4. Database Migrations
```bash
pnpm --filter @codeguard/db db:push
```

### 5. Run Development Server
```bash
pnpm run dev
```

Visit `http://localhost:3000` to access the application dashboard.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
