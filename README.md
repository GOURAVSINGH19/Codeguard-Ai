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

## 📐 GitHub-Optimized Architecture & Flowcharts

### 1. End-to-End System Execution Flowchart

```mermaid
flowchart TD
    subgraph Trigger["1. Trigger Source"]
        A1["Developer Opens/Updates PR on GitHub"]
        A2["User Triggers Review on Web Dashboard"]
    end

    subgraph Ingestion["2. Ingestion & Auth Layer"]
        B1["GitHub Webhook Event: POST /api/webhooks/github"]
        B2["Manual API Trigger: POST /api/github/review"]
        B3{"Verify HMAC Signature & Auth Token"}
    end

    subgraph Orchestration["3. Queue & Async Orchestration"]
        C1[("Save Review in DB: status = pending")]
        C2["Enqueue Review Job into Redis / BullMQ"]
        C3["Return HTTP 202 Accepted Immediately"]
    end

    subgraph WorkerPipeline["4. Async Worker Execution"]
        D1["Worker Dequeues Review Job"]
        D2["Octokit REST API Fetches PR Patch Diff"]
        D3["Parse Modified Files & Line Mappings"]
    end

    subgraph AIReview["5. AI Analysis Engine"]
        E1["Format Diff into Structured Prompt (v2.1)"]
        E2["Send Prompt to Llama 3.3 70B Engine"]
        E3["Validate Structured Output with Zod Schema"]
    end

    subgraph Deduplication["6. Deduplication & Persistence"]
        F1["Compute SHA256 Issue Fingerprint"]
        F2{"Check Existing Fingerprints in DB"}
        F3["Skip Previously Posted Issues"]
        F4[("Save Findings & Telemetry: status = completed")]
    end

    subgraph Notification["7. GitHub Inline Comments"]
        G1["Format GitHub Markdown Review Comments"]
        G2["Post Inline Comments via Octokit Review API"]
        G3["Fallback to Octokit Issue Comment API"]
        G4["Review Comments Appear on GitHub PR!"]
    end

    A1 --> B1
    A2 --> B2
    B1 --> B3
    B2 --> B3
    B3 -->|Valid| C1
    C1 --> C2
    C2 --> C3
    C2 --> D1
    D1 --> D2
    D2 --> D3
    D3 --> E1
    E1 --> E2
    E2 --> E3
    E3 --> F1
    F1 --> F2
    F2 -->|New Issue| F4
    F2 -->|Duplicate| F3
    F4 --> G1
    G1 --> G2
    G2 -->|Success| G4
    G2 -->|Fallback| G3
    G3 --> G4
```

---

### 2. Step-by-Step Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant GH as GitHub REST API
    participant Webhook as Webhook Route Handler
    participant Queue as BullMQ Job Queue
    participant Worker as Background Worker
    participant LLM as Llama 3.3 70B Model
    participant DB as Neon PostgreSQL DB

    Dev->>GH: Open PR or Push Commits
    GH->>Webhook: POST /api/webhooks/github (pull_request)
    Webhook->>DB: Insert Review Record (status: pending)
    Webhook->>Queue: Enqueue Job { reviewId, prId, repoId }
    Webhook-->>GH: HTTP 202 Accepted (Non-blocking)
    
    Queue->>Worker: Consume Review Job
    Worker->>GH: GET /repos/{owner}/{repo}/pulls/{pr}/files
    GH-->>Worker: Return Unified Patch Diffs & Offsets
    
    Worker->>LLM: Stream Diff & Prompt Context
    LLM-->>Worker: Structured JSON Findings (Issues & Fixes)
    
    Worker->>Worker: Zod Schema Parse & SHA256 Fingerprinting
    Worker->>DB: Fetch Existing Issue Fingerprints
    DB-->>Worker: Existing Fingerprints List
    
    Worker->>Worker: Exclude Duplicate Findings
    Worker->>DB: Update Review Status (completed) & Telemetry
    
    Worker->>GH: POST Line-Anchored Inline Comments (Octokit)
    GH-->>Dev: Inline Comments Published on GitHub PR
```

---

## 🔍 Detailed Component Breakdown: How Each Part Works

### 1. Ingestion & Authentication Layer
- **GitHub Webhook Listener (`/api/webhooks/github`)**: Listens for incoming GitHub `pull_request` events (`opened`, `synchronize`, `reopened`). Validates cryptographic `X-Hub-Signature-256` HMAC headers using `GITHUB_WEBHOOK_SECRET`.
- **User Scoped Auth (Clerk + GitHub OAuth)**: Ensures API endpoints verify current authenticated user session (`review.userId === currentUser.id`).

### 2. Asynchronous Job Queue Pipeline
- **Decoupled Architecture**: HTTP Webhook endpoints respond with `202 Accepted` immediately, preventing GitHub webhook timeouts.
- **BullMQ + Redis / Node Worker**: Enqueues payload parameters (`reviewId`, `installationId`, `repositoryId`, `pullRequestNumber`).
- **State Machine Engine**: Tracks status updates (`pending` $\rightarrow$ `processing` $\rightarrow$ `completed` / `failed`).

### 3. Diff Extraction & Line Anchoring
- **Octokit Diff Extractor**: Uses standard GitHub REST APIs to fetch precise modified files and unified diff patches (`@@ -start,count +start,count @@`).
- **Line Matching Engine**: Converts patch chunk line offsets to exact file line numbers to ensure AI suggestions anchor to the exact line modified in the PR.

### 4. AI Analysis & Telemetry Engine
- **Llama 3.3 70B Model**: Prompts LLM using structured system guidelines for code quality, security vulnerabilities (OWASP Top 10), performance, and maintainability.
- **Zod Runtime Validation**: Parses raw LLM outputs through a strict Zod schema (`score`, `summary`, `issues` array).
- **Observability Telemetry**: Captures performance metrics:
  ```json
  {
    "model": "llama-3.3-70b-versatile",
    "promptVersion": "v2.1",
    "durationMs": 12450,
    "filesReviewed": 7,
    "linesReviewed": 340,
    "issuesFound": 4
  }
  ```

### 5. Fingerprint Deduplication System
- Prevents comment spam across subsequent PR commits.
- Generates a unique fingerprint using:
  $$\text{Fingerprint} = \text{SHA256}(\text{repository} + \text{pr} + \text{filePath} + \text{lineNumber} + \text{category} + \text{issueHash})$$
- Queries existing database records to discard duplicates before posting to GitHub.

### 6. Automated GitHub Comment Posting
- Uses Octokit REST API (`octokit.rest.pulls.createReview`) to post structured multi-line inline comments directly on changed files.
- Includes automatic fallback to issue comments (`octokit.rest.issues.createComment`) if review permissions or draft constraints prevent inline reviews.

---

## ⭐ Production-Grade Engineering Pillars

| Feature | SDE-1 Engineering Value | Benefit |
| :--- | :--- | :--- |
| **Async Worker Queue** | Asynchronous execution, non-blocking HTTP endpoints | High throughput, zero request timeouts |
| **Webhook Bot** | Event-driven developer workflow integration | Automatic reviews without manual copying |
| **Observability** | Telemetry tracking (tokens, model latency, prompt version) | Cost monitoring & model evaluation |
| **Deduplication Engine** | SHA256 deterministic issue fingerprinting | Zero comment spam on revised commits |
| **Zod Schema Parsing** | Guaranteed AI output runtime validation | Type-safe database persistence |

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
GROQ_MODEL=llama-3.3-70b-versatile

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
