import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  const body = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>HAR Journal</title>
    <link>https://harproject.cloud/blog</link>
    <description>Architecture, field notes, and practical patterns for reliable coding-agent workflows.</description>
    <language>en</language>
    <item>
      <title>Why coding agents need a harness, not another prompt.</title>
      <link>https://harproject.cloud/blog/why-coding-agents-need-a-harness</link>
      <guid>https://harproject.cloud/blog/why-coding-agents-need-a-harness</guid>
      <pubDate>Sat, 18 Jul 2026 10:00:00 GMT</pubDate>
      <description>Coding models can edit files. Reliable software work requires a surrounding system that can isolate, launch, verify, and explain what happened.</description>
    </item>
  </channel>
</rss>`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
