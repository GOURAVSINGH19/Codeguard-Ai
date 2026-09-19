import Parser from "web-tree-sitter";

export interface ASTChunk {
  content: string;
  startLine: number;  // 1-indexed
  endLine: number;    // 1-indexed, inclusive
  nodeType: "function" | "class" | "method" | "interface" | "type" | "variable" | "block";
  name: string;       // function/class/type name for context
}

interface LanguageConfig {
  name: string;
  extensions: string[];
  query: string;  // Tree-sitter query for extracting nodes
  parserModule: () => Promise<any>;
}

/**
 * ASTChunker
 *
 * Uses tree-sitter to parse source code and extract semantic chunks
 * (functions, classes, methods, interfaces, etc.) instead of fixed-size
 * line windows. This preserves code structure and context at boundaries.
 *
 * Supported languages: TypeScript, JavaScript, Python, Go, Rust, Java, C++
 */
export class ASTChunker {
  private parsers: Map<string, Parser> = new Map();
  private languages: Map<string, LanguageConfig> = new Map();
  private initialized = false;

  /**
   * Initialize tree-sitter parsers for all supported languages.
   * Must be called before chunking.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize the tree-sitter WASM module
    await Parser.init();

    // Language configurations with tree-sitter queries
    // Each query captures the node, its type, and name for context
    const languageConfigs: LanguageConfig[] = [
      {
        name: "typescript",
        extensions: [".ts", ".tsx"],
        parserModule: () => import("tree-sitter-typescript").then((m) => m.typescript),
        query: `
          (function_declaration name: (identifier) @name) @function
          (function_expression name: (identifier) @name) @function
          (arrow_function) @function
          (method_definition name: (property_identifier) @name) @method
          (class_declaration name: (type_identifier) @name) @class
          (interface_declaration name: (type_identifier) @name) @interface
          (type_alias_declaration name: (type_identifier) @name) @type
          (variable_declarator name: (identifier) @name) @variable
        `,
      },
      {
        name: "javascript",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        parserModule: () => import("tree-sitter-typescript").then((m) => m.javascript),
        query: `
          (function_declaration name: (identifier) @name) @function
          (function_expression name: (identifier) @name) @function
          (arrow_function) @function
          (method_definition name: (property_identifier) @name) @method
          (class_declaration name: (identifier) @name) @class
          (variable_declarator name: (identifier) @name) @variable
        `,
      },
      {
        name: "python",
        extensions: [".py"],
        parserModule: () => import("tree-sitter-python"),
        query: `
          (function_definition name: (identifier) @name) @function
          (class_definition name: (identifier) @name) @class
          (async_function_definition name: (identifier) @name) @function
        `,
      },
      {
        name: "go",
        extensions: [".go"],
        parserModule: () => import("tree-sitter-go"),
        query: `
          (function_declaration name: (identifier) @name) @function
          (method_declaration name: (field_identifier) @name) @method
          (type_declaration (type_spec name: (type_identifier) @name)) @type
        `,
      },
      {
        name: "rust",
        extensions: [".rs"],
        parserModule: () => import("tree-sitter-rust"),
        query: `
          (function_item name: (identifier) @name) @function
          (struct_item name: (type_identifier) @name) @class
          (enum_item name: (type_identifier) @name) @class
          (trait_item name: (type_identifier) @name) @interface
          (impl_item) @block
        `,
      },
      {
        name: "java",
        extensions: [".java"],
        parserModule: () => import("tree-sitter-java"),
        query: `
          (method_declaration name: (identifier) @name) @method
          (class_declaration name: (identifier) @name) @class
          (interface_declaration name: (identifier) @name) @interface
          (constructor_declaration name: (identifier) @name) @method
        `,
      },
      {
        name: "cpp",
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
        parserModule: () => import("tree-sitter-cpp"),
        query: `
          (function_definition declarator: (function_declarator declarator: (identifier) @name)) @function
          (class_specifier name: (type_identifier) @name) @class
          (struct_specifier name: (type_identifier) @name) @class
        `,
      },
    ];

    for (const config of languageConfigs) {
      try {
        const parser = new Parser();
        const language = await config.parserModule();
        parser.setLanguage(language);
        this.parsers.set(config.name, parser);
        this.languages.set(config.name, config);

        // Also register by extension
        for (const ext of config.extensions) {
          this.languages.set(ext, config);
        }
      } catch (err) {
        console.warn(`[ASTChunker] Failed to load ${config.name} parser:`, err);
      }
    }

    this.initialized = true;
  }

  /**
   * Check if a language is supported for AST chunking.
   */
  isSupported(languageOrExtension: string): boolean {
    return this.languages.has(languageOrExtension.toLowerCase());
  }

  /**
   * Chunk a file's content using AST-based semantic chunking.
   * Falls back to returning the whole file as one chunk if AST parsing fails.
   *
   * @param content    Full file content as a string
   * @param language   Language identifier or file extension (e.g., "typescript", ".ts")
   * @returns          Array of semantic chunks with content and line ranges
   */
  async chunk(content: string, languageOrExtension: string): Promise<ASTChunk[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const language = languageOrExtension.toLowerCase();
    const config = this.languages.get(language);

    if (!config) {
      return []; // Unsupported language
    }

    const parser = this.parsers.get(config.name);
    if (!parser) {
      return [];
    }

    try {
      const tree = parser.parse(content);
      const query = new Parser.Query(config.query);
      const captures = query.captures(tree.rootNode);

      const chunks: ASTChunk[] = [];

      // Group captures by the main node (@function, @class, @method, etc.)
      const nodeGroups = new Map<Parser.SyntaxNode, { type: string; name: string }>();

      for (const capture of captures) {
        const node = capture.node;
        const captureName = capture.name;

        if (captureName === "name") {
          // This is a name node, associate it with its parent
          const parent = node.parent;
          if (parent) {
            const existing = nodeGroups.get(parent);
            nodeGroups.set(parent, {
              type: existing?.type || "",
              name: node.text,
            });
          }
        } else if (captureName.endsWith("function") || captureName.endsWith("class") ||
                   captureName.endsWith("method") || captureName.endsWith("interface") ||
                   captureName.endsWith("type") || captureName.endsWith("variable") ||
                   captureName.endsWith("block")) {
          // This is a main node type
          const existing = nodeGroups.get(node);
          nodeGroups.set(node, {
            type: captureName,
            name: existing?.name || "",
          });
        }
      }

      // Convert grouped nodes to chunks
      for (const [node, info] of nodeGroups) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const nodeContent = node.text;

        // Skip very small nodes (< 3 lines) or very large ones (> 200 lines)
        const lineCount = endLine - startLine + 1;
        if (lineCount < 3 || lineCount > 200) continue;

        // Map tree-sitter capture names to our types
        let nodeType: ASTChunk["nodeType"] = "block";
        if (info.type.includes("function")) nodeType = "function";
        else if (info.type.includes("method")) nodeType = "method";
        else if (info.type.includes("class")) nodeType = "class";
        else if (info.type.includes("interface")) nodeType = "interface";
        else if (info.type.includes("type")) nodeType = "type";
        else if (info.type.includes("variable")) nodeType = "variable";

        chunks.push({
          content: nodeContent,
          startLine,
          endLine,
          nodeType,
          name: info.name || "anonymous",
        });
      }

      // Sort by start line
      chunks.sort((a, b) => a.startLine - b.startLine);

      // If no chunks found, fall back to whole file
      if (chunks.length === 0) {
        return [{
          content,
          startLine: 1,
          endLine: content.split("\n").length,
          nodeType: "block",
          name: "file",
        }];
      }

      return chunks;
    } catch (err) {
      console.warn(`[ASTChunker] Failed to parse ${language}:`, err);
      return []; // Signal failure, caller should fall back
    }
  }

  /**
   * Get list of supported languages.
   */
  getSupportedLanguages(): string[] {
    return Array.from(this.languages.keys()).filter(k => !k.startsWith("."));
  }
}

// Export a singleton instance
export const astChunker = new ASTChunker();