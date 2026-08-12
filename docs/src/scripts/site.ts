import type { PostHog } from 'posthog-js';

declare global {
  interface Window {
    posthog?: PostHog;
  }
}

const html = document.documentElement;

function setTheme(theme: 'light' | 'dark', persist = true) {
  html.dataset.theme = theme;
  html.style.colorScheme = theme;
  if (persist) localStorage.setItem('har-theme', theme);

  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    const next = theme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.setAttribute('title', `Switch to ${next} theme`);
    const label = button.querySelector<HTMLElement>('[data-theme-label]');
    if (label) label.textContent = `Switch to ${next} theme`;
  });
}

setTheme(html.dataset.theme === 'dark' ? 'dark' : 'light', false);

document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    setTheme(html.dataset.theme === 'dark' ? 'light' : 'dark');
  });
});

const header = document.querySelector<HTMLElement>('[data-header]');
const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12);
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

const menuButton = document.querySelector<HTMLButtonElement>('[data-menu-button]');
const mobileMenu = document.querySelector<HTMLElement>('[data-mobile-menu]');
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!open));
  mobileMenu?.classList.toggle('is-open', !open);
});
mobileMenu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  menuButton?.setAttribute('aria-expanded', 'false');
  mobileMenu?.classList.remove('is-open');
}));

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver?.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 })
  : null;

document.querySelectorAll('.reveal').forEach((element) => {
  if (revealObserver) revealObserver.observe(element);
  else element.classList.add('is-visible');
});

for (const copyButton of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  copyButton.addEventListener('click', async () => {
    const label = copyButton.querySelector<HTMLElement>('[data-copy-label]');
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copy ?? '');
      window.posthog?.capture('install_command_copied');
      if (label) label.textContent = 'Copied';
      window.setTimeout(() => { if (label) label.textContent = 'Copy'; }, 1500);
    } catch {
      if (label) label.textContent = 'Select';
    }
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>('[data-newsletter-form], [data-web3form]')) {
  const status = form.querySelector<HTMLElement>('[data-web3form-status]')
    ?? form.parentElement?.querySelector<HTMLElement>('[data-newsletter-status], [data-web3form-status]');
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const defaultStatus = status?.innerHTML ?? '';
  const successMessage = form.dataset.successMessage ?? 'Subscribed — thanks for following along.';
  const sendingLabel = form.dataset.sendingLabel ?? 'Sending…';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!submitButton) return;

    const originalLabel = submitButton.textContent ?? 'Submit';
    submitButton.disabled = true;
    submitButton.textContent = sendingLabel;

    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { success?: boolean; message?: string };

      if (response.ok && result.success) {
        window.posthog?.capture(
          form.matches('[data-newsletter-form]')
            ? 'newsletter_subscription_completed'
            : 'enterprise_interest_submitted',
        );
        form.reset();
        if (status) status.textContent = successMessage;
      } else if (status) {
        status.textContent = result.message ?? 'Something went wrong. Try again in a moment.';
      }
    } catch {
      if (status) status.textContent = 'Could not reach the signup service. Try again later.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
      if (status && !status.textContent) status.innerHTML = defaultStatus;
    }
  });
}

type WorkflowContent = {
  label: string;
  title: string;
  body: string;
  docLabel: string;
  docHref: string;
  method: string;
  detail: string;
  json: string;
};

const workflowContent: Record<string, WorkflowContent> = {
  discover: {
    label: '01 — Discover',
    title: 'The agent reads one stable interface.',
    body: 'The agent asks HAR what the repository can launch, verify, inspect, reset, and tear down, all through one interface.',
    docLabel: 'MCP tools',
    docHref: '/docs/reference/mcp/',
    method: 'har_describe_project',
    detail: 'project description',
    json: '{\n  "profile": "default",\n  "agentSlots": 3,\n  "stages": [\n    "launch", "verify", "test"\n  ]\n}',
  },
  isolate: {
    label: '02 — Isolate',
    title: 'Every task gets a clean slot.',
    body: 'HAR gives the task its own worktree, branch, ports, and, where the project needs it, a database, so nothing is shared with the main checkout.',
    docLabel: 'How slots work',
    docHref: '/docs/guides/agent-workflow/#before-editing',
    method: 'har_launch_environment',
    detail: 'slot allocation',
    json: '{\n  "slot": 2,\n  "worktree": "~/worktrees/my-app-agent-2",\n  "previewUrl": "localhost:4102",\n  "status": "ready"\n}',
  },
  build: {
    label: '03 — Build',
    title: 'The agent edits inside the harness.',
    body: 'The agent edits and tests inside that isolated worktree using the project’s own tools, while the main checkout stays untouched.',
    docLabel: 'Editing in the harness',
    docHref: '/docs/guides/agent-workflow/#during-implementation',
    method: 'har_get_status',
    detail: 'live environment',
    json: '{\n  "processes": 3,\n  "healthy": true,\n  "dirtyFiles": 4,\n  "mainCheckout": "clean"\n}',
  },
  verify: {
    label: '04 — Verify',
    title: 'Project checks become a deterministic pipeline.',
    body: 'The project’s own checks run through the same pipeline every time and return a consistent status with duration, logs, and artifacts.',
    docLabel: 'How verification works',
    docHref: '/docs/guides/verification/',
    method: 'har_run_verification',
    detail: 'normalized results',
    json: '{\n  "result": "passed",\n  "durationMs": 31200,\n  "stages": 6,\n  "artifacts": 5\n}',
  },
  handoff: {
    label: '05 — Hand off',
    title: 'The result arrives with evidence.',
    body: 'Once verification passes, the session is torn down and the branch is kept with the proof of what ran, so a reviewer gets the code plus the evidence.',
    docLabel: 'Session handoff',
    docHref: '/docs/guides/agent-workflow/#session-handoff',
    method: 'har_get_run',
    detail: 'reviewable handoff',
    json: '{\n  "branch": "agent/slot-02",\n  "treeHash": "7a1c9d4",\n  "verification": "passed",\n  "readyForReview": true\n}',
  },
};

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const tabs = document.querySelectorAll<HTMLButtonElement>('[data-workflow-tab]');
const copyRoot = document.querySelector<HTMLElement>('[data-workflow-copy]');
const visualPanel = document.querySelector<HTMLElement>('.workflow-visual-panel');

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    tabs.forEach((item) => item.classList.toggle('active', item === tab));
    const key = tab.dataset.workflowTab;
    const content = key ? workflowContent[key] : undefined;
    if (!content || !copyRoot || !visualPanel) return;

    window.posthog?.capture('workflow_stage_selected', { workflow_stage: key });
    copyRoot.innerHTML = `<span class="workflow-label">${content.label}</span><h3>${content.title}</h3><p>${content.body}</p><a class="workflow-doc-link" href="${content.docHref}">${content.docLabel} <span aria-hidden="true">→</span></a>`;
    const highlightedJson = escapeHtml(content.json).replaceAll('\"', '<span>\"</span>');
    visualPanel.innerHTML = `<div class="visual-panel-header"><span>HAR MCP</span><small>${content.detail}</small></div><div class="mcp-call"><span class="mcp-method">tool</span><strong>${content.method}</strong><small>repo: /workspace/my-app</small></div><div class="json-card"><pre>${highlightedJson}</pre></div>`;
  });
}

function initHeroTerminalTilt() {
  const root = document.querySelector<HTMLElement>('[data-hero-terminal]');
  const stage = root?.querySelector<HTMLElement>('[data-hero-terminal-stage]');
  if (!root || !stage) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (reducedMotion || !finePointer) return;

  const baseRotateX = 1;
  const baseRotateY = -3;
  const maxTilt = 8;
  const parallaxNotes = [...root.querySelectorAll<HTMLElement>('[data-hero-parallax]')];

  const setStage = (rotateX: number, rotateY: number, lift = 0) => {
    stage.style.transform = `rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateZ(${lift}px)`;
  };

  setStage(baseRotateX, baseRotateY);

  root.addEventListener('mousemove', (event) => {
    const rect = root.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;

    setStage(baseRotateX - y * maxTilt * 2, baseRotateY + x * maxTilt * 2, 14);
    root.classList.add('is-tilting');

    parallaxNotes.forEach((note, index) => {
      const depth = index === 0 ? 1.15 : 0.85;
      note.style.transform = `translate3d(${(x * 16 * depth).toFixed(2)}px, ${(y * 12 * depth).toFixed(2)}px, ${24 + index * 10}px)`;
    });
  });

  root.addEventListener('mouseleave', () => {
    root.classList.remove('is-tilting');
    setStage(baseRotateX, baseRotateY);
    parallaxNotes.forEach((note) => {
      note.style.transform = '';
    });
  });
}

initHeroTerminalTilt();

function initVideoModal() {
  const modal = document.querySelector<HTMLElement>('[data-video-modal]');
  const slot = modal?.querySelector<HTMLElement>('[data-video-slot]');
  if (!modal || !slot) return;

  const src = 'https://www.youtube.com/embed/XKl4ZzWy7mQ?autoplay=1&rel=0';

  const open = () => {
    slot.innerHTML = `<iframe src="${src}" title="HAR introduction demo" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    window.posthog?.capture('demo_video_opened');
  };

  const close = () => {
    modal.hidden = true;
    slot.innerHTML = '';
    document.body.style.overflow = '';
  };

  document.querySelectorAll('[data-video-open]').forEach((button) => button.addEventListener('click', open));
  modal.querySelectorAll('[data-video-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });
}

initVideoModal();

function touchDistance(a: Touch, b: Touch) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function initDashboardImageModal() {
  const modal = document.querySelector<HTMLElement>('[data-dashboard-image-modal]');
  const viewport = modal?.querySelector<HTMLElement>('[data-dashboard-image-viewport]');
  const target = modal?.querySelector<HTMLImageElement>('[data-dashboard-image-target]');
  if (!modal || !viewport || !target) return;

  const mobileQuery = window.matchMedia('(max-width: 760px)');
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;
  let isPanning = false;
  let lastTapAt = 0;

  const applyTransform = () => {
    target.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
  };

  const resetTransform = () => {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
  };

  const open = (src: string, alt: string) => {
    target.src = src;
    target.alt = alt;
    resetTransform();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    window.posthog?.capture('dashboard_image_opened', { src });
  };

  const close = () => {
    modal.hidden = true;
    target.removeAttribute('src');
    target.alt = '';
    document.body.style.overflow = '';
    resetTransform();
  };

  document.querySelectorAll<HTMLImageElement>('img[data-dashboard-zoom]').forEach((trigger) => {
    trigger.tabIndex = mobileQuery.matches ? 0 : -1;
    trigger.setAttribute('role', mobileQuery.matches ? 'button' : 'presentation');

    const handleOpen = () => {
      if (!mobileQuery.matches) return;
      open(trigger.currentSrc || trigger.src, trigger.alt);
    };

    trigger.addEventListener('click', handleOpen);
    trigger.addEventListener('keydown', (event) => {
      if (!mobileQuery.matches) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleOpen();
      }
    });
  });

  mobileQuery.addEventListener('change', () => {
    document.querySelectorAll<HTMLImageElement>('img[data-dashboard-zoom]').forEach((trigger) => {
      trigger.tabIndex = mobileQuery.matches ? 0 : -1;
      trigger.setAttribute('role', mobileQuery.matches ? 'button' : 'presentation');
    });
    if (!mobileQuery.matches && !modal.hidden) close();
  });

  viewport.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length === 2) {
        isPanning = false;
        pinchStartDistance = touchDistance(event.touches[0], event.touches[1]);
        pinchStartScale = scale;
        return;
      }

      if (event.touches.length === 1 && scale > 1) {
        isPanning = true;
        panStartX = event.touches[0].clientX;
        panStartY = event.touches[0].clientY;
        panOriginX = translateX;
        panOriginY = translateY;
      }
    },
    { passive: true },
  );

  viewport.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        const distance = touchDistance(event.touches[0], event.touches[1]);
        scale = Math.min(4, Math.max(1, pinchStartScale * (distance / pinchStartDistance)));
        if (scale === 1) {
          translateX = 0;
          translateY = 0;
        }
        applyTransform();
        return;
      }

      if (isPanning && event.touches.length === 1) {
        event.preventDefault();
        translateX = panOriginX + (event.touches[0].clientX - panStartX);
        translateY = panOriginY + (event.touches[0].clientY - panStartY);
        applyTransform();
      }
    },
    { passive: false },
  );

  viewport.addEventListener('touchend', (event) => {
    if (event.touches.length > 0) return;

    isPanning = false;

    if (event.changedTouches.length !== 1) return;

    const now = Date.now();
    if (now - lastTapAt < 280) {
      if (scale > 1) {
        resetTransform();
      } else {
        scale = 2;
        applyTransform();
      }
    }
    lastTapAt = now;
  });

  modal.querySelectorAll('[data-dashboard-image-close]').forEach((button) => {
    button.addEventListener('click', close);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });
}

initDashboardImageModal();
