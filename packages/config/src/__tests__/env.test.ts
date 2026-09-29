import { describe, it, expect, afterEach } from "vitest";
import { EnvSchema, getLLMConfig, getKafkaConfig, getGitHubAppConfig, MissingConfigError } from "../env";

const parse = (vars: Record<string, string>) => EnvSchema.parse(vars);

describe("getLLMConfig", () => {
  it("never sends an OpenAI key to Groq", () => {
    const env = parse({ LLM_PROVIDER: "groq", OPENAI_API_KEY: "sk-openai" });
    expect(() => getLLMConfig(env)).toThrow(MissingConfigError);
  });

  it("uses each provider's own key, base URL and model", () => {
    expect(getLLMConfig(parse({ GROQ_API_KEY: "gsk", GROQ_MODEL: "g-model" }))).toMatchObject({
      provider: "groq",
      apiKey: "gsk",
      model: "g-model",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    expect(getLLMConfig(parse({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk" }))).toMatchObject({
      provider: "openai",
      apiKey: "sk",
      baseUrl: "https://api.openai.com/v1",
    });
  });
});

describe("getKafkaConfig", () => {
  it("verifies TLS certificates by default when SASL is used", () => {
    const cfg = getKafkaConfig(parse({ KAFKA_BROKERS: "b:9092", KAFKA_USERNAME: "u", KAFKA_PASSWORD: "p" }));
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.sasl?.mechanism).toBe("scram-sha-256");
  });

  it("only disables verification when explicitly asked", () => {
    const cfg = getKafkaConfig(parse({ KAFKA_USERNAME: "u", KAFKA_PASSWORD: "p", KAFKA_SSL_REJECT_UNAUTHORIZED: "false" }));
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("uses plaintext for a local broker without credentials", () => {
    expect(getKafkaConfig(parse({})).ssl).toBe(false);
    expect(getKafkaConfig(parse({})).brokers).toEqual(["localhost:19092"]);
  });
});

describe("getGitHubAppConfig", () => {
  it("turns literal \\n in the private key into newlines", () => {
    const cfg = getGitHubAppConfig(parse({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----" }));
    expect(cfg.privateKey).toBe("-----BEGIN-----\nabc\n-----END-----");
  });

  it("names the missing variables", () => {
    expect(() => getGitHubAppConfig(parse({}))).toThrow(/GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY/);
  });
});

afterEach(() => {});
