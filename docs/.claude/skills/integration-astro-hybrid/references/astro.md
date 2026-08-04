# Astro - Docs

PostHog makes it easy to get data about traffic and usage of your [Astro](https://astro.build/) app. Integrating PostHog into your site enables analytics about user behavior, custom events capture, session recordings, feature flags, and more.

This guide walks you through integrating PostHog into your Astro app using the [JavaScript Web SDK](/docs/libraries/js.md).

## Beta: integration via LLM

Install PostHog for Astro in seconds with our wizard by running this prompt with [LLM coding agents](/blog/envoy-wizard-llm-agent.md) like Cursor and Bolt, or by running it in your terminal.

`npx @posthog/wizard`

[Learn more](/wizard.md)

Or, to integrate manually, continue with the rest of this guide.

## Installation

In your `src/components` folder, create a `posthog.astro` file:

Terminal

PostHog AI

```bash
cd ./src/components
# or 'cd ./src && mkdir components && cd ./components' if your components folder doesnt exist
touch posthog.astro
```

In this file, add your `Web snippet` which you can find in [your project settings](https://us.posthog.com/settings/project#snippet). Be sure to include the `is:inline` directive [to prevent Astro from processing it](https://docs.astro.build/en/guides/client-side-scripts/#opting-out-of-processing), or you will get Typescript and build errors that property 'posthog' does not exist on type 'Window & typeof globalThis'.

posthog.astro

PostHog AI

```javascript
<script is:inline>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagResult reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys getNextSurveyStep onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('<ph_project_token>', {
    api_host:'https://us.i.posthog.com',
    defaults: '2026-05-30'
  })
</script>
```

> **If your site sets a Content-Security-Policy**, it needs to allow PostHog. This applies to the snippet and to package installs alike: the SDK lazy-loads extra bundles (session replay, surveys) from PostHog's CDN, and sends events to the ingestion host. PostHog serves from subdomains of `posthog.com` that change over time, so allow the wildcard:
>
> PostHog AI
>
> ```
> script-src 'self' https://*.posthog.com;
> connect-src 'self' https://*.posthog.com;
> worker-src 'self' blob: data:;
> ```
>
> `script-src` covers the snippet and the lazy-loaded bundles, `connect-src` covers event ingestion and feature flags, and `worker-src` covers session replay. The [toolbar needs a few more](/docs/advanced/content-security-policy.md), or use a [reverse proxy](/docs/advanced/proxy.md) so everything is first-party. Failing to do so causes silent failures where `capture` and `identify` calls never send, so the integration looks complete while zero events arrive. Remember `connect-src` falls back to `default-src`, so `default-src 'self'` blocks event delivery even when the script itself is bundled.

**Using with Astro's view transitions (ClientRouter)**

If you've opted in to Astro's `<ClientRouter>` component for client-side navigation, you'll need to add an initialization guard to prevent PostHog from running multiple times during page transitions.

Update your `posthog.astro` file to wrap the snippet with a check:

posthog.astro

PostHog AI

```javascript
---
// src/components/posthog.astro
---
<script is:inline>
  if (!window.__posthog_initialized) {
    window.__posthog_initialized = true;
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagResult reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys getNextSurveyStep onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    posthog.init('<ph_project_token>', {
      api_host: 'https://us.i.posthog.com',
      defaults: '2026-05-30',
      capture_pageview: 'history_change'
    })
  }
</script>
```

Without this guard, `ClientRouter`'s soft navigation can re-execute the inline script during page transitions, causing a stack overflow error. The `capture_pageview: 'history_change'` option ensures pageviews are tracked automatically as users navigate.

The next step is to a create a [Layout](https://docs.astro.build/en/core-concepts/layouts/) where we will use `posthog.astro`. Create a new file `PostHogLayout.astro` in your `src/layouts` folder:

Terminal

PostHog AI

```bash
cd .. && cd .. # move back to your base directory if you're still in src/components/posthog.astro
cd ./src/layouts
# or 'cd ./src && mkdir layouts && cd ./layouts' if your layouts folder doesn't exist yet
touch PostHogLayout.astro
```

Add the following code to `PostHogLayout.astro`:

PostHogLayout.astro

PostHog AI

```javascript
---
import PostHog from '../components/posthog.astro'
---
<head>
    <PostHog />
</head>
```

Lastly, update `index.astro` to wrap your existing app components with the new Layout:

index.astro

PostHog AI

```javascript
---
import PostHogLayout from '../layouts/PostHogLayout.astro';
---
<PostHogLayout>
  <!-- your existing app components -->
</PostHogLayout>
```

## Identifying users

> **Identifying users is required.** Call `posthog.identify('your-user-id')` after login to link events to a known user. This is what connects frontend event captures, [session replays](/docs/session-replay.md), [LLM traces](/docs/ai-engineering.md), and [error tracking](/docs/error-tracking.md) to the same person — and lets backend events link back too.
>
> Use a stable ID from your auth system when possible, not an email or display name. Send those as person properties instead. If your app has no other stable key, email works as a fallback if they are unique. Never a shared literal like `"anonymous"` or `"user"`, which pools many people onto one person and corrupts their data. When no ID is available at all, skip the identify and retain the anonymous distinct ID that's automatically assigned.
>
> Call `posthog.reset()` on logout, so the next person to use the browser doesn't inherit the last one's identity.
>
> See our guide on [identifying users](/docs/getting-started/identify-users.md) for how to set this up.

If your app calls your own backend, `tracing_headers` adds `X-POSTHOG-DISTINCT-ID` and `X-POSTHOG-SESSION-ID` to matching `fetch` and `XMLHttpRequest` requests. This lets server-side SDKs link backend events, errors, and LLM traces back to frontend sessions and replays. Use hostnames only, without protocols or paths.

JavaScript

PostHog AI

```javascript
posthog.init('<ph_project_token>', {
  api_host: 'https://us.i.posthog.com',
  // Optional: send PostHog session/user context to your backend
  tracing_headers: ['api.example.com'],
})
```

This works in local development too, but match on the hostname alone: use `'localhost'`, not `'localhost:3000'`. Ports are never part of a hostname, so a value with one in it never matches anything. `localhost` and `127.0.0.1` are also different hostnames — use whichever your app actually calls.

Tracing headers help you attribute events across front and backend consistently. When this isn't available, use your server-side stable IDs to deduce the matching `distinctId`, and pass it in when capturing the event.

Set up a reverse proxy (recommended)

We recommend [setting up a reverse proxy](/docs/advanced/proxy.md), so that events are less likely to be intercepted by tracking blockers.

We have our [own managed reverse proxy service](/docs/advanced/proxy/managed-reverse-proxy.md), which is free for all PostHog Cloud users, routes through our infrastructure, and makes setting up your proxy easy.

If you don't want to use our managed service then there are several other options for creating a reverse proxy, including using [Cloudflare](/docs/advanced/proxy/cloudflare.md), [AWS Cloudfront](/docs/advanced/proxy/cloudfront.md), and [Vercel](/docs/advanced/proxy/vercel.md).

Grouping products in one project (recommended)

If you have multiple customer-facing products (e.g. a marketing website + mobile app + web app), it's best to install PostHog on them all and [group them in one project](/docs/settings/projects.md).

This makes it possible to track users across their entire journey (e.g. from visiting your marketing website to signing up for your product), or how they use your product across multiple platforms.

Add IPs to Firewall/WAF allowlists (recommended)

For certain features like [heatmaps](/docs/toolbar/heatmaps.md), your Web Application Firewall (WAF) may be blocking PostHog's requests to your site. Add these IP addresses to your WAF allowlist or rules to let PostHog access your site.

**EU**: `3.75.65.221`, `18.197.246.42`, `3.120.223.253`

**US**: `44.205.89.55`, `52.4.194.122`, `44.208.188.173`

These are public, stable IPs used by PostHog services (e.g., Celery tasks for snapshots).

## Next steps

For any technical questions for how to integrate specific PostHog features into Astro (such as analytics, feature flags, A/B testing, surveys, etc.), have a look at our [JavaScript Web SDK docs](/docs/libraries/js/features.md).

Alternatively, the following tutorials can help you get started:

-   [How to set up Astro analytics, feature flags, and more](/tutorials/astro-analytics.md)
-   [How to set up A/B tests in Astro](/tutorials/astro-ab-tests.md)
-   [How to set up surveys in Astro](/tutorials/astro-surveys.md)

### Community questions

Ask a question

### Was this page useful?

HelpfulCould be better