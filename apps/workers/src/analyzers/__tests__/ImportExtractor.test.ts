import { describe, it, expect } from "vitest";
import { ImportResolver } from "@codeguard/review-engine";
import { ImportExtractor } from "../ImportExtractor.js";

describe("ImportExtractor", () => {
  it("converts Python relative imports to paths", () => {
    const specs = new ImportExtractor().extractSpecifiers("from .models import User\nfrom ..core.db import session\nimport os\n");
    expect(specs).toEqual(expect.arrayContaining(["./models", "../core/db"]));
  });

  it("resolves aliases and workspace packages only to files that exist", () => {
    const resolver = new ImportResolver({
      files: ["apps/web/src/page.tsx", "apps/web/src/lib/api.ts", "packages/db/index.ts"],
      pathAliases: { "@/*": ["apps/web/src/*"] },
      workspacePackages: { "@codeguard/db": "packages/db" },
    });
    const source = `import { api } from "@/lib/api";\nimport { db } from "@codeguard/db";\nimport React from "react";\nimport x from "./nope";`;
    expect(new ImportExtractor(resolver).extractImports(source, "apps/web/src/page.tsx").sort()).toEqual(["apps/web/src/lib/api.ts", "packages/db/index.ts"]);
  });

  it("keeps the old relative-only guess without a resolver", () => {
    expect(new ImportExtractor().extractImports(`import a from "./a"; import b from "@/b";`, "src/x.ts")).toEqual(["src/a.ts"]);
  });
});
