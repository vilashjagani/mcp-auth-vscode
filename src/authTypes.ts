export type AuthMethod = "device" | "client_credentials" | "password" | "basic" | "api_key";

export interface ServerAuthState {
  method: AuthMethod;
  /** Bearer / access token (device, client_credentials, password grant) */
  accessToken?: string;
  tokenType?: string;
  expiresAt?: number;   // unix epoch ms; undefined = never expires (basic/api_key)
  refreshToken?: string;
  /** Stored for client_credentials / password grant silent refresh — SecretStorage only */
  clientSecret?: string;
  /** Stored for password grant silent refresh — SecretStorage only, NEVER settings */
  password?: string;
}

export interface ServerAuthConfig {
  method: AuthMethod;
  // device / client_credentials / password grant shared
  clientId?: string;
  clientSecret?: string;   // sensitive — never in settings.json
  deviceAuthEndpoint?: string;
  tokenEndpoint?: string;
  scopes?: string;
  // password grant + basic auth
  username?: string;
  password?: string;       // sensitive — never in settings.json
  // api key
  apiKey?: string;         // sensitive — never in settings.json
  apiKeyHeader?: string;   // default: "x-api-key"
  // tls
  allowInsecureTls?: boolean;
}
