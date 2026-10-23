import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// AI access (Better Auth, tables "auth_*").
// The OAuth 2.1 server ChatGPT and Claude use to sign in to Life (@life/voice-auth). Shapes are
// Better Auth's (user, session, account, verification, jwks and the OAuth
// provider's tables); its adapter reads and writes them. Prefixed, apart from the archive.

// Better Auth's adapter turns arrays and JSON into text itself on SQLite.
const at = (name: string) => integer(name, { mode: "timestamp_ms" });
const boolean = (name: string) => integer(name, { mode: "boolean" });

export const authUser = sqliteTable("auth_user", {
  createdAt: at("created_at").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const authSession = sqliteTable(
  "auth_session",
  {
    createdAt: at("created_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: at("updated_at").notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user").on(t.userId)]
);

export const authAccount = sqliteTable(
  "auth_account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    accountId: text("account_id").notNull(),
    createdAt: at("created_at").notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    updatedAt: at("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_account_user").on(t.userId)]
);

export const authVerification = sqliteTable(
  "auth_verification",
  {
    createdAt: at("created_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: at("updated_at").notNull(),
    value: text("value").notNull(),
  },
  (t) => [index("auth_verification_identifier").on(t.identifier)]
);

export const authJwks = sqliteTable("auth_jwks", {
  alg: text("alg"),
  createdAt: at("created_at").notNull(),
  crv: text("crv"),
  expiresAt: at("expires_at"),
  id: text("id").primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
});

export const authOauthClient = sqliteTable(
  "auth_oauth_client",
  {
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required"
    ),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    clientCredentialsScopes: text("client_credentials_scopes"),
    clientDiscoveryId: text("client_discovery_id"),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    contacts: text("contacts"),
    createdAt: at("created_at"),
    disabled: boolean("disabled"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens"),
    enableEndSession: boolean("enable_end_session"),
    grantTypes: text("grant_types"),
    icon: text("icon"),
    id: text("id").primaryKey(),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    metadata: text("metadata"),
    name: text("name"),
    policy: text("policy"),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    redirectUris: text("redirect_uris").notNull(),
    referenceId: text("reference_id"),
    requirePKCE: boolean("require_pkce"),
    responseTypes: text("response_types"),
    scopes: text("scopes"),
    skipConsent: boolean("skip_consent"),
    softwareId: text("software_id"),
    softwareStatement: text("software_statement"),
    softwareVersion: text("software_version"),
    subjectType: text("subject_type"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    tos: text("tos"),
    updatedAt: at("updated_at"),
    uri: text("uri"),
    userId: text("user_id").references(() => authUser.id),
  },
  (t) => [index("auth_oauth_client_user").on(t.userId)]
);

export const authOauthResource = sqliteTable("auth_oauth_resource", {
  accessTokenTtl: integer("access_token_ttl"),
  allowedScopes: text("allowed_scopes"),
  createdAt: at("created_at"),
  customClaims: text("custom_claims"),
  disabled: boolean("disabled"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required"),
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  metadata: text("metadata"),
  name: text("name").notNull(),
  policyVersion: integer("policy_version"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  updatedAt: at("updated_at"),
});

export const authOauthClientResource = sqliteTable(
  "auth_oauth_client_resource",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => authOauthClient.clientId, { onDelete: "cascade" }),
    createdAt: at("created_at"),
    id: text("id").primaryKey(),
    metadata: text("metadata"),
    resourceId: text("resource_id")
      .notNull()
      .references(() => authOauthResource.identifier, { onDelete: "cascade" }),
  },
  (t) => [
    index("auth_oauth_client_resource_client").on(t.clientId),
    index("auth_oauth_client_resource_resource").on(t.resourceId),
  ]
);

// Columns both token tables share.
const grant = () => ({
  authorizationCodeId: text("authorization_code_id"),
  clientId: text("client_id")
    .notNull()
    .references(() => authOauthClient.clientId),
  confirmation: text("confirmation"),
  createdAt: at("created_at"),
  expiresAt: at("expires_at"),
  id: text("id").primaryKey(),
  referenceId: text("reference_id"),
  requestedUserInfoClaims: text("requested_user_info_claims"),
  resources: text("resources"),
  revoked: at("revoked"),
  scopes: text("scopes").notNull(),
  sessionId: text("session_id").references(() => authSession.id, {
    onDelete: "set null",
  }),
});

export const authOauthRefreshToken = sqliteTable(
  "auth_oauth_refresh_token",
  {
    ...grant(),
    authTime: at("auth_time"),
    rotatedAt: at("rotated_at"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id),
  },
  (t) => [
    index("auth_oauth_refresh_token_client").on(t.clientId),
    index("auth_oauth_refresh_token_user").on(t.userId),
    index("auth_oauth_refresh_token_code").on(t.authorizationCodeId),
  ]
);

export const authOauthAccessToken = sqliteTable(
  "auth_oauth_access_token",
  {
    ...grant(),
    refreshId: text("refresh_id").references(() => authOauthRefreshToken.id),
    token: text("token").unique(),
    userId: text("user_id").references(() => authUser.id),
  },
  (t) => [
    index("auth_oauth_access_token_client").on(t.clientId),
    index("auth_oauth_access_token_user").on(t.userId),
    index("auth_oauth_access_token_code").on(t.authorizationCodeId),
  ]
);

export const authOauthConsent = sqliteTable(
  "auth_oauth_consent",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => authOauthClient.clientId),
    createdAt: at("created_at"),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    resources: text("resources"),
    scopes: text("scopes").notNull(),
    updatedAt: at("updated_at"),
    userId: text("user_id").references(() => authUser.id),
  },
  (t) => [index("auth_oauth_consent_client").on(t.clientId)]
);

export const authOauthClientAssertion = sqliteTable(
  "auth_oauth_client_assertion",
  {
    expiresAt: at("expires_at").notNull(),
    id: text("id").primaryKey(),
  }
);

// Keyed by Better Auth's model names, as its Drizzle adapter expects.
export const authSchema = {
  account: authAccount,
  jwks: authJwks,
  oauthAccessToken: authOauthAccessToken,
  oauthClient: authOauthClient,
  oauthClientAssertion: authOauthClientAssertion,
  oauthClientResource: authOauthClientResource,
  oauthConsent: authOauthConsent,
  oauthRefreshToken: authOauthRefreshToken,
  oauthResource: authOauthResource,
  session: authSession,
  user: authUser,
  verification: authVerification,
};
