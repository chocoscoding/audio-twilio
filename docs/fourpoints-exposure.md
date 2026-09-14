# FourPoints exposure request — telephony gateway

**Ask:** let one server-side client, the telephony gateway, open realtime
WebSocket sessions on the deployed stack. This is an infrastructure/config
change only: **no application code, protocol, or browser-path change.**

## Why a change is needed at all

The deployed `/ws` path only admits browser sessions: the ALB rule runs
`authenticate-cognito` with `OnUnauthenticatedRequest: DENY`, and the service
(`REQUIRE_AUTH=true`) refuses upgrades without ALB-issued OIDC claims. A
server cannot complete that browser login, so it cannot connect today.

Locally nothing is needed: `npm run start:realtime` leaves `REQUIRE_AUTH`
unset and the gateway connects to `ws://localhost:8787` as-is.

## Changes (all in `infrastructure/cdk/lib/fourpoints-demo-stack.ts`)

### 1. Cognito machine client (existing user pool)

```ts
const realtimeServer = userPool.addResourceServer('RealtimeResourceServer', {
  identifier: 'fourpoints-realtime',
  scopes: [
    new cognito.ResourceServerScope({
      scopeName: 'telephony.session',
      scopeDescription: 'Open realtime sessions for the telephony gateway',
    }),
  ],
});

const telephonyClient = userPool.addClient('TelephonyGatewayClient', {
  generateSecret: true,
  oAuth: {
    flows: { clientCredentials: true },
    scopes: [
      cognito.OAuthScope.resourceServer(realtimeServer, {
        scopeName: 'telephony.session',
        scopeDescription: 'Open realtime sessions for the telephony gateway',
      }),
    ],
  },
});
```

The client secret goes to the gateway's secret store; never to outputs or
logs. Check Cognito machine-to-machine pricing.

### 2. Telephony realtime service

A second Fargate service running the **same image tag**, same task and
execution roles, same private subnets, security-group ingress **only from the
ALB security group**, its own target group on `/healthz` — with `REQUIRE_AUTH`
unset. Sizing is independent of the browser service, and phone traffic gets
its own per-task consumption budget.

### 3. ALB listener rule (priority above the existing `/ws` rule)

```ts
new elbv2.CfnListenerRule(this, 'TelephonyWsRule', {
  listenerArn: httpsListener.listenerArn,
  priority: 5, // lower number than the /ws, /ws/* rule
  conditions: [
    { field: 'path-pattern', pathPatternConfig: { values: ['/ws/telephony'] } },
  ],
  actions: [
    {
      type: 'jwt-validation',
      order: 1,
      jwtValidationConfig: {
        jwksEndpoint: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}/.well-known/jwks.json`,
        issuer: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`,
        additionalClaims: [
          {
            name: 'scope',
            format: 'space-separated-values',
            values: ['fourpoints-realtime/telephony.session'],
          },
          {
            name: 'client_id',
            format: 'single-string',
            values: [telephonyClient.userPoolClientId],
          },
        ],
      },
    },
    {
      type: 'forward',
      order: 2,
      targetGroupArn: telephonyTargetGroup.targetGroupArn,
    },
  ],
});
```

ALB JWT verification requires an HTTPS listener, RS256 tokens and a publicly
reachable JWKS (≤10 keys, ≤150 KB); Cognito meets all three, and the internal
ALB already reaches Cognito through the existing NAT gateways. Confirm the
CloudFormation property names against current documentation when applying.

### 4. CloudFront and WAF

No change expected: the `/ws/*` behaviour already covers `/ws/telephony`,
uses the AllViewer origin request policy (forwards `Authorization`) and has
caching disabled. The WAF rate rule (600 requests / 5 minutes per IP) bounds
the gateway's egress IP to roughly 120 new calls per minute — raise it for
that IP if needed.

## Security note (for the Decision Ledger)

The telephony service runs without the application-level upgrade check. The
compensating controls are the ALB JWT validation (signature, `iss`, `exp`,
`scope`, `client_id`) and a security group that admits only the ALB. The
browser service and its controls are unchanged. The gateway itself only
accepts Twilio-signed webhooks and media streams.

## Gateway configuration after the change

```bash
FOURPOINTS_WS_URL=wss://app.fourpointsls.com/ws/telephony
FOURPOINTS_AUTH=client-credentials
FOURPOINTS_TOKEN_URL=https://<cognito-domain>.auth.us-east-1.amazoncognito.com/oauth2/token
FOURPOINTS_CLIENT_ID=<telephony client id>
FOURPOINTS_CLIENT_SECRET=<from secret store>
FOURPOINTS_SCOPE=fourpoints-realtime/telephony.session
```
