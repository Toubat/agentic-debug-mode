import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../src/domain/redaction";

describe("secret redaction", () => {
  test("redacts common credential key variants without matching unrelated keys", () => {
    const result = redactSecrets({
      apiKey: "api-secret",
      authorizationHeader: "Bearer secret",
      nested: {
        access_token: "access-secret",
        clientSecret: "client-secret",
        monkey: "safe",
        tokenCount: 3,
      },
      "x-api-key": "header-secret",
    });

    expect(result.value).toEqual({
      apiKey: "[REDACTED]",
      authorizationHeader: "[REDACTED]",
      nested: {
        access_token: "[REDACTED]",
        clientSecret: "[REDACTED]",
        monkey: "safe",
        tokenCount: 3,
      },
      "x-api-key": "[REDACTED]",
    });
    expect(result.redactedPaths).toEqual([
      "apiKey",
      "authorizationHeader",
      "nested.access_token",
      "nested.clientSecret",
      "x-api-key",
    ]);
  });

  test("redacts the complete acronym matrix while preserving nested lookalikes", () => {
    const result = redactSecrets({
      APIKey: "api-key-secret",
      APIToken: "api-token-secret",
      IDToken: "id-token-secret",
      OAuthToken: "oauth-token-secret",
      exact: {
        Cookie: "cookie-secret",
        Password: "password-secret",
        Secret: "exact-secret",
        Token: "exact-token",
      },
      nested: [
        {
          "client-secret": "client-secret",
          refreshToken: "refresh-secret",
        },
        {
          designToken: "design-token",
          fortuneCookie: "fortune-cookie",
          passwordPolicy: "password-policy",
          secretSauceName: "secret-sauce",
          tokenCount: 4,
        },
      ],
    });

    expect(result.value).toEqual({
      APIKey: "[REDACTED]",
      APIToken: "[REDACTED]",
      IDToken: "[REDACTED]",
      OAuthToken: "[REDACTED]",
      exact: {
        Cookie: "[REDACTED]",
        Password: "[REDACTED]",
        Secret: "[REDACTED]",
        Token: "[REDACTED]",
      },
      nested: [
        {
          "client-secret": "[REDACTED]",
          refreshToken: "[REDACTED]",
        },
        {
          designToken: "design-token",
          fortuneCookie: "fortune-cookie",
          passwordPolicy: "password-policy",
          secretSauceName: "secret-sauce",
          tokenCount: 4,
        },
      ],
    });
    expect(result.redactedPaths).toEqual([
      "APIKey",
      "APIToken",
      "IDToken",
      "OAuthToken",
      "exact.Cookie",
      "exact.Password",
      "exact.Secret",
      "exact.Token",
      "nested[0].client-secret",
      "nested[0].refreshToken",
    ]);
  });
});
