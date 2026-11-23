const TASK_CATEGORIES = [
  'Social media tasks',
  'Website visits',
  'App testing',
  'Surveys',
  'Data entry',
  'Research tasks',
  'Content evaluation',
  'Writing tasks',
];

function getApiBase() {
  if (typeof window !== 'undefined' && typeof window.TASKNOVA_API_BASE === 'string') {
    return window.TASKNOVA_API_BASE.replace(/\/$/, '');
  }
  const meta = document.querySelector('meta[name="tasknova-api-base"]');
  const content = meta?.getAttribute('content')?.trim() || '';
  return content.replace(/\/$/, '');
}

const API_BASE = getApiBase();

const state = {
  token: null, // Strictly kept in JS memory (never localStorage/sessionStorage)
  user: null,
  wallet: null,
  employer: null,
  authStatus: {
    hasAdmin: true,
    requiresBootstrapKey: false,
    smtpConfigured: false,
    googleAuthConfigured: false,
  },
  activeView: 'marketplace',
  activeAdminTab: 'withdrawals',
  tasks: [],
  submissions: [],
  objectUrls: [],
};

// Safe DOM creation helper (prevents XSS by never interpolating untrusted HTML)
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dKey, dVal] of Object.entries(value)) {
        node.dataset[dKey] = String(dVal);
      }
    } else {
      node.setAttribute(key, String(value));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function formatUsd(cents) {
  const num = Number(cents || 0) / 100;
  return `$${num.toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toast(message, type = 'info') {
  const region = document.getElementById('toast-region');
  const node = el('div', {
    className: `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`,
    text: message,
  });
  region.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, 5200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) {
    headers.set('Authorization', `Bearer ${state.token}`);
  }
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const err = new Error(data?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function statusBadge(status) {
  return el('span', { className: `status-tag status-${status}`, text: status.replace(/_/g, ' ') });
}

function revokePreviewUrls() {
  while (state.objectUrls.length) {
    URL.revokeObjectURL(state.objectUrls.pop());
  }
}

async function createAuthImagePreview(filename) {
  const container = el('div', { className: 'subtle-text', text: 'Loading screenshot...' });
  if (!filename || !state.token) {
    container.textContent = '';
    return container;
  }
  try {
    const res = await fetch(`${API_BASE}/api/tasks/uploads/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) {
      container.textContent = 'Screenshot unavailable.';
      return container;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    clearNode(container);
    container.appendChild(
      el('img', {
        className: 'proof-preview-img',
        src: url,
        alt: 'Worker submitted task proof screenshot',
      })
    );
  } catch {
    container.textContent = 'Unable to load screenshot attachment.';
  }
  return container;
}

function populateCategorySelects() {
  const filterSelect = document.getElementById('filter-category');
  const createSelect = document.getElementById('task-category');

  for (const cat of TASK_CATEGORIES) {
    filterSelect.appendChild(el('option', { value: cat, text: cat }));
    createSelect.appendChild(el('option', { value: cat, text: cat }));
  }
}

function updateChrome() {
  const isLoggedIn = Boolean(state.user);
  const isAdmin = state.user?.role === 'admin';

  document.querySelectorAll('.auth-only').forEach((node) => {
    node.classList.toggle('hidden', !isLoggedIn);
  });
  document.querySelectorAll('.guest-only').forEach((node) => {
    node.classList.toggle('hidden', isLoggedIn);
  });
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.classList.toggle('hidden', !isAdmin);
  });

  document.getElementById('header-available-balance').textContent = formatUsd(
    state.wallet?.availableCents || 0
  );

  const adminBanner = document.getElementById('first-run-admin-banner');
  adminBanner.classList.toggle('hidden', state.authStatus.hasAdmin);

  const verifyBanner = document.getElementById('email-verify-banner');
  verifyBanner.classList.toggle('hidden', !isLoggedIn || Boolean(state.user?.emailVerified));

  const tabAdminSetup = document.getElementById('tab-admin-setup');
  tabAdminSetup.classList.toggle('hidden', state.authStatus.hasAdmin);

  const keyWrap = document.getElementById('adm-init-key-wrap');
  keyWrap.classList.toggle('hidden', !state.authStatus.requiresBootstrapKey);

  const googleBtn = document.getElementById('btn-google-signin');
  googleBtn.classList.toggle('hidden', !window.TaskNovaFirebaseAuth);
}

function switchView(viewName) {
  if (viewName !== 'marketplace' && !state.user) {
    openAuthModal('login');
    toast('Sign in to access your TaskNova workspace.', 'info');
    return;
  }
  if (viewName === 'admin' && state.user?.role !== 'admin') {
    toast('Administrator privileges are required for that section.', 'error');
    return;
  }

  state.activeView = viewName;
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('hidden', section.id !== `view-${viewName}`);
    section.classList.toggle('active', section.id === `view-${viewName}`);
  });
  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  if (viewName === 'marketplace') loadMarketplace();
  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'submissions') loadMySubmissions();
  if (viewName === 'wallet') loadWallet();
  if (viewName === 'employer') loadEmployerPortal();
  if (viewName === 'admin') loadAdminDashboard();
  if (viewName === 'account') loadAccountView();
  if (viewName === 'notifications') loadNotifications();
}

function openAuthModal(tab = 'login') {
  const modal = document.getElementById('auth-modal');
  modal.classList.remove('hidden');
  switchAuthTab(tab);
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
}

function switchAuthTab(tab) {
  const titles = {
    login: 'Sign In to TaskNova',
    register: 'Create a TaskNova Account',
    reset: 'Reset Account Password',
    'admin-setup': 'Initialize Primary Administrator',
  };
  document.getElementById('auth-modal-title').textContent = titles[tab] || 'TaskNova Account';

  document.querySelectorAll('#auth-tabs .subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.authTab === tab);
  });

  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('reset-pane').classList.toggle('hidden', tab !== 'reset');
  document.getElementById('admin-setup-form').classList.toggle('hidden', tab !== 'admin-setup');
}

async function refreshSession() {
  try {
    const status = await api('/api/auth/status');
    state.authStatus = status;
  } catch {
    // keep defaults
  }

  if (state.token) {
    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
      state.wallet = me.wallet;
      state.employer = me.employer;
      const badge = document.getElementById('unread-badge');
      badge.textContent = String(me.unreadNotifications || 0);
      badge.classList.toggle('hidden', !me.unreadNotifications);
    } catch {
      state.token = null;
      state.user = null;
      state.wallet = null;
      state.employer = null;
    }
  }
  updateChrome();
}

// ============================================================================
// MARKETPLACE
// ============================================================================
async function loadMarketplace() {
  const q = document.getElementById('filter-search').value.trim();
  const category = document.getElementById('filter-category').value;
  const difficulty = document.getElementById('filter-difficulty').value;
  const sort = document.getElementById('filter-sort').value;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (difficulty) params.set('difficulty', difficulty);
  if (sort) params.set('sort', sort);

  try {
    const data = await api(`/api/tasks?${params.toString()}`);
    state.tasks = data.tasks || [];
    renderMarketplace();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMarketplace() {
  const grid = document.getElementById('marketplace-grid');
  const empty = document.getElementById('marketplace-empty');
  clearNode(grid);

  let openSlots = 0;
  for (const t of state.tasks) {
    openSlots += Math.max(0, t.maxQuantity - t.approvedCount);
  }
  document.getElementById('mk-active-count').textContent = String(state.tasks.length);
  document.getElementById('mk-open-slots').textContent = String(openSlots);

  if (state.tasks.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const task of state.tasks) {
    const remaining = Math.max(0, task.maxQuantity - task.approvedCount);
    const card = el('article', { className: 'task-card' }, [
      el('div', {}, [
        el('div', { className: 'task-card-top' }, [
          el('div', {}, [
            el('div', { className: 'task-meta-line', text: task.category }),
            el('h3', { text: task.title }),
          ]),
          el('div', { className: 'task-reward tabular-nums', text: formatUsd(task.rewardCents) }),
        ]),
        el('p', { className: 'task-desc', text: task.description }),
      ]),
      el('div', {}, [
        el('div', { className: 'task-foot' }, [
          el('span', { text: `${task.employerCompany} · ${task.difficulty} · ~${task.estimatedMinutes}m` }),
          el('span', { className: 'tabular-nums', text: `${remaining}/${task.maxQuantity} left` }),
        ]),
        el('div', { className: 'btn-row', style: 'margin-top:12px;' }, [
          el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: 'View Instructions & Accept',
            onClick: () => openTaskModal(task.id),
          }),
        ]),
      ]),
    ]);
    grid.appendChild(card);
  }
}

async function openTaskModal(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}`);
    const task = data.task;
    const modal = document.getElementById('task-modal');
    const body = document.getElementById('task-modal-body');
    document.getElementById('task-modal-title').textContent = task.title;
    clearNode(body);

    const remaining = Math.max(0, task.maxQuantity - task.approvedCount);
    body.appendChild(
      el('div', { className: 'sub-item' }, [
        el('div', { className: 'sub-item-head' }, [
          el('strong', { text: `${task.category} · ${task.employerCompany}` }),
          el('strong', { className: 'task-reward tabular-nums', text: `${formatUsd(task.rewardCents)} Reward` }),
        ]),
        el('div', {
          className: 'subtle-text',
          text: `Difficulty: ${task.difficulty} · Estimated time: ${task.estimatedMinutes} min · Slots open: ${remaining}/${task.maxQuantity}`,
        }),
      ])
    );

    body.appendChild(el('div', {}, [el('h4', { text: 'Description' }), el('p', { text: task.description })]));
    body.appendChild(el('div', {}, [el('h4', { text: 'Step-by-Step Instructions' }), el('p', { text: task.instructions })]));
    body.appendChild(el('div', {}, [el('h4', { text: 'Required Proof' }), el('p', { text: task.proofRequirements })]));

    const acceptBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      text: state.user ? 'Accept Task & Start' : 'Sign In to Accept Task',
      onClick: async () => {
        if (!state.user) {
          modal.classList.add('hidden');
          openAuthModal('login');
          return;
        }
        acceptBtn.disabled = true;
        try {
          await api(`/api/tasks/${task.id}/accept`, { method: 'POST' });
          toast('Task accepted! Submit your proof from My Tasks.', 'success');
          modal.classList.add('hidden');
          switchView('submissions');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          acceptBtn.disabled = false;
        }
      },
    });

    body.appendChild(acceptBtn);
    modal.classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================
// WORKER DASHBOARD & SUBMISSIONS
// ============================================================================
async function loadDashboard() {
  try {
    const data = await api('/api/users/dashboard');
    state.wallet = data.wallet;
    updateChrome();

    document.getElementById('dash-available').textContent = formatUsd(data.wallet.availableCents);
    document.getElementById('dash-pending').textContent = formatUsd(data.wallet.pendingCents);
    document.getElementById('dash-earned').textContent = formatUsd(data.wallet.totalEarnedCents);
    document.getElementById('dash-approved').textContent = String(data.stats.approvedCount);
    document.getElementById('dash-rate').textContent = `${data.stats.successRate}%`;

    const tbody = document.getElementById('dash-recent-body');
    clearNode(tbody);
    if (!data.recentSubmissions.length) {
      tbody.appendChild(
        el('tr', {}, [el('td', { colspan: '5', className: 'subtle-text', text: 'No task activity recorded yet.' })])
      );
      return;
    }

    for (const item of data.recentSubmissions) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: item.taskTitle }),
          el('td', { text: item.taskCategory }),
          el('td', { className: 'tabular-nums', text: formatUsd(item.rewardCentsSnapshot) }),
          el('td', {}, [statusBadge(item.status)]),
          el('td', { text: formatDate(item.acceptedAt) }),
        ])
      );
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadMySubmissions() {
  revokePreviewUrls();
  try {
    const data = await api('/api/tasks/my-submissions');
    state.submissions = data.submissions || [];
    const list = document.getElementById('submissions-list');
    const empty = document.getElementById('submissions-empty');
    clearNode(list);

    if (!state.submissions.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    for (const sub of state.submissions) {
      const card = el('div', { className: 'sub-item' }, [
        el('div', { className: 'sub-item-head' }, [
          el('div', {}, [
            el('strong', { text: sub.taskTitle }),
            el('div', { className: 'subtle-text', text: `${sub.taskCategory} · ${sub.employerCompany}` }),
          ]),
          el('div', { className: 'btn-row' }, [
            el('strong', { className: 'tabular-nums', text: formatUsd(sub.rewardCentsSnapshot) }),
            statusBadge(sub.status),
          ]),
        ]),
        el('div', { className: 'subtle-text', text: `Instructions: ${sub.taskInstructions}` }),
        el('div', { className: 'subtle-text', text: `Proof Required: ${sub.taskProofRequirements}` }),
      ]);

      if (sub.textProof) {
        card.appendChild(el('div', {}, [el('strong', { text: 'Your Proof: ' }), el('span', { text: sub.textProof })]));
      }
      if (sub.reviewerNote) {
        card.appendChild(el('div', { className: 'subtle-text', text: `Reviewer Note: ${sub.reviewerNote}` }));
      }
      if (sub.screenshotPath) {
        card.appendChild(await createAuthImagePreview(sub.screenshotPath));
      }

      if (sub.status === 'accepted') {
        card.appendChild(
          el('div', { className: 'btn-row' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              text: 'Submit Text & Screenshot Proof',
              onClick: () => openProofModal(sub),
            }),
          ])
        );
      }

      list.appendChild(card);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openProofModal(sub) {
  document.getElementById('proof-submission-id').value = String(sub.id);
  document.getElementById('proof-task-req').textContent = `Required: ${sub.taskProofRequirements}`;
  document.getElementById('proof-text').value = '';
  document.getElementById('proof-file').value = '';
  document.getElementById('proof-modal').classList.remove('hidden');
}

// ============================================================================
// WALLET & WITHDRAWALS
// ============================================================================
async function loadWallet() {
  try {
    const data = await api('/api/wallet');
    state.wallet = data.wallet;
    updateChrome();

    document.getElementById('wal-available').textContent = formatUsd(data.wallet.availableCents);
    document.getElementById('wal-pending').textContent = formatUsd(data.wallet.pendingCents);
    document.getElementById('wal-earned').textContent = formatUsd(data.wallet.totalEarnedCents);
    document.getElementById('wal-withdrawn').textContent = formatUsd(data.wallet.totalWithdrawnCents);

    const provList = document.getElementById('wallet-providers-list');
    clearNode(provList);
    for (const prov of data.providers || []) {
      provList.appendChild(
        el('div', { className: 'sub-item' }, [
          el('div', { className: 'sub-item-head' }, [
            el('strong', { text: prov.label }),
            statusBadge(prov.configured ? 'active' : 'pending_verification'),
          ]),
          el('div', {
            className: 'subtle-text',
            text: prov.configured
              ? `Provider credentials detected (${prov.environment}).`
              : `Awaiting live credentials: ${prov.requiredCredentials.join(', ')}`,
          }),
          el('div', { className: 'subtle-text', text: prov.complianceNotes.join(' ') }),
        ])
      );
    }

    const wdBody = document.getElementById('wallet-withdrawals-body');
    clearNode(wdBody);
    if (!data.withdrawals.length) {
      wdBody.appendChild(el('tr', {}, [el('td', { colspan: '7', className: 'subtle-text', text: 'No withdrawal requests yet.' })]));
    } else {
      for (const w of data.withdrawals) {
        wdBody.appendChild(
          el('tr', {}, [
            el('td', { text: `#${w.id}` }),
            el('td', { text: w.method.toUpperCase() }),
            el('td', { text: w.destinationAccount }),
            el('td', { className: 'tabular-nums', text: formatUsd(w.amountCents) }),
            el('td', {}, [statusBadge(w.status)]),
            el('td', { text: w.providerReference || w.providerError || 'Awaiting review' }),
            el('td', { text: formatDate(w.createdAt) }),
          ])
        );
      }
    }

    const txBody = document.getElementById('wallet-transactions-body');
    clearNode(txBody);
    if (!data.transactions.length) {
      txBody.appendChild(el('tr', {}, [el('td', { colspan: '6', className: 'subtle-text', text: 'No ledger transactions yet.' })]));
    } else {
      for (const t of data.transactions) {
        txBody.appendChild(
          el('tr', {}, [
            el('td', { text: t.type.replace(/_/g, ' ') }),
            el('td', { text: t.description }),
            el('td', { className: 'tabular-nums', text: formatUsd(t.amountCents) }),
            el('td', { className: 'tabular-nums', text: formatUsd(t.balanceAfterAvailableCents) }),
            el('td', {}, [statusBadge(t.status)]),
            el('td', { text: formatDate(t.createdAt) }),
          ])
        );
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================
// EMPLOYER PORTAL
// ============================================================================
async function loadEmployerPortal() {
  revokePreviewUrls();
  try {
    const data = await api('/api/employers/overview');
    state.employer = data.employer;

    const onboarding = document.getElementById('employer-onboarding-card');
    const workspace = document.getElementById('employer-workspace');

    if (!data.employer) {
      onboarding.classList.remove('hidden');
      workspace.classList.add('hidden');
      return;
    }

    onboarding.classList.add('hidden');
    workspace.classList.remove('hidden');

    const banner = document.getElementById('employer-verification-banner');
    clearNode(banner);
    banner.className = `banner ${data.employer.verificationStatus === 'verified' ? '' : 'banner-warn'}`;
    banner.appendChild(
      el('div', {}, [
        el('strong', { text: `${data.employer.companyName} — Verification: ${data.employer.verificationStatus.toUpperCase()} ` }),
        el('span', {
          text:
            data.employer.verificationStatus === 'verified'
              ? 'Your organization is verified to fund and publish microtask campaigns.'
              : 'Pending administrator approval before campaign creation and funding are unlocked.',
        }),
      ])
    );

    document.getElementById('emp-balance').textContent = formatUsd(data.employer.availableCampaignBalanceCents);
    document.getElementById('emp-total-funded').textContent = formatUsd(data.employer.totalFundedCents);
    document.getElementById('emp-total-spent').textContent = formatUsd(data.employer.totalSpentCents);

    const tasksBody = document.getElementById('emp-tasks-body');
    clearNode(tasksBody);
    if (!data.tasks.length) {
      tasksBody.appendChild(el('tr', {}, [el('td', { colspan: '7', className: 'subtle-text', text: 'No campaigns created yet.' })]));
    } else {
      for (const task of data.tasks) {
        const totalCostCents = task.rewardCents * task.maxQuantity;
        const actionCell = el('td');
        if (task.fundingStatus === 'unfunded') {
          actionCell.appendChild(
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              text: `Fund & Publish (${formatUsd(totalCostCents)})`,
              onClick: async () => {
                try {
                  await api(`/api/employers/tasks/${task.id}/fund`, { method: 'POST' });
                  toast('Task campaign funded and published to marketplace!', 'success');
                  loadEmployerPortal();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            })
          );
        } else {
          actionCell.textContent = task.fundingStatus;
        }

        tasksBody.appendChild(
          el('tr', {}, [
            el('td', { text: task.title }),
            el('td', { text: task.category }),
            el('td', { className: 'tabular-nums', text: formatUsd(task.rewardCents) }),
            el('td', { className: 'tabular-nums', text: `${task.approvedCount}/${task.maxQuantity}` }),
            el('td', { className: 'tabular-nums', text: `${formatUsd(task.spentBudgetCents)} / ${formatUsd(task.fundedBudgetCents)}` }),
            el('td', {}, [statusBadge(task.status)]),
            actionCell,
          ])
        );
      }
    }

    const subsList = document.getElementById('emp-submissions-list');
    clearNode(subsList);
    if (!data.submissions.length) {
      subsList.appendChild(el('p', { className: 'subtle-text', text: 'No worker proof submissions received yet.' }));
    } else {
      for (const sub of data.submissions) {
        const card = el('div', { className: 'sub-item' }, [
          el('div', { className: 'sub-item-head' }, [
            el('div', {}, [
              el('strong', { text: `${sub.taskTitle} — ${sub.workerName}` }),
              el('div', { className: 'subtle-text', text: `${sub.workerEmail} · Submitted ${formatDate(sub.submittedAt)}` }),
            ]),
            el('div', { className: 'btn-row' }, [
              el('strong', { className: 'tabular-nums', text: formatUsd(sub.rewardCentsSnapshot) }),
              statusBadge(sub.status),
            ]),
          ]),
          el('div', {}, [el('strong', { text: 'Proof: ' }), el('span', { text: sub.textProof || '(none)' })]),
        ]);

        if (sub.screenshotPath) {
          card.appendChild(await createAuthImagePreview(sub.screenshotPath));
        }

        if (sub.status === 'submitted') {
          const reasonInput = el('input', {
            type: 'text',
            placeholder: 'Optional note or required rejection reason...',
          });
          card.appendChild(
            el('div', { className: 'btn-row' }, [
              reasonInput,
              el('button', {
                type: 'button',
                className: 'btn btn-primary btn-sm',
                text: 'Approve & Release Reward',
                onClick: async () => {
                  try {
                    await api(`/api/employers/submissions/${sub.id}/approve`, {
                      method: 'POST',
                      body: JSON.stringify({ note: reasonInput.value.trim() || undefined }),
                    });
                    toast('Submission approved and reward moved to worker balance.', 'success');
                    loadEmployerPortal();
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              }),
              el('button', {
                type: 'button',
                className: 'btn btn-danger btn-sm',
                text: 'Reject Proof',
                onClick: async () => {
                  const note = reasonInput.value.trim();
                  if (note.length < 4) {
                    toast('Enter a rejection reason (at least 4 characters) first.', 'error');
                    return;
                  }
                  try {
                    await api(`/api/employers/submissions/${sub.id}/reject`, {
                      method: 'POST',
                      body: JSON.stringify({ note }),
                    });
                    toast('Submission rejected.', 'info');
                    loadEmployerPortal();
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              }),
            ])
          );
        }
        subsList.appendChild(card);
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================
async function loadAdminDashboard() {
  revokePreviewUrls();
  try {
    const [overview, withdrawalsData, employersData, subsData, tasksData, usersData, txData, logsData] =
      await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/withdrawals'),
        api('/api/admin/employers'),
        api('/api/admin/submissions'),
        api('/api/admin/tasks'),
        api('/api/admin/users'),
        api('/api/admin/transactions'),
        api('/api/admin/logs'),
      ]);

    const a = overview.analytics;
    document.getElementById('adm-users').textContent = String(a.usersCount);
    document.getElementById('adm-employers').textContent = String(a.employersCount);
    document.getElementById('adm-tasks').textContent = String(a.tasksCount);
    document.getElementById('adm-proofs').textContent = String(a.pendingProofsCount);
    document.getElementById('adm-withdrawals').textContent = String(a.pendingWithdrawalsCount);

    // Withdrawals queue
    const wdBody = document.getElementById('adm-withdrawals-body');
    clearNode(wdBody);
    for (const w of withdrawalsData.withdrawals || []) {
      const actions = el('td', { className: 'btn-row' });
      if (['pending', 'failed'].includes(w.status)) {
        const rejectInput = el('input', {
          type: 'text',
          placeholder: 'Rejection reason...',
          style: 'max-width:150px;',
        });
        actions.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: 'Execute Payout',
            onClick: async () => {
              try {
                await api(`/api/admin/withdrawals/${w.id}/execute-payout`, { method: 'POST' });
                toast(`Payout #${w.id} executed via provider.`, 'success');
                loadAdminDashboard();
              } catch (err) {
                toast(err.message, 'error');
                loadAdminDashboard();
              }
            },
          })
        );
        actions.appendChild(rejectInput);
        actions.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-danger btn-sm',
            text: 'Reject & Refund',
            onClick: async () => {
              const reason = rejectInput.value.trim();
              if (reason.length < 4) {
                toast('Provide a rejection reason (4+ chars).', 'error');
                return;
              }
              try {
                await api(`/api/admin/withdrawals/${w.id}/reject`, {
                  method: 'POST',
                  body: JSON.stringify({ reason }),
                });
                toast(`Withdrawal #${w.id} rejected and refunded.`, 'info');
                loadAdminDashboard();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          })
        );
      } else {
        actions.textContent = w.providerReference || w.reviewNote || 'Processed';
      }

      wdBody.appendChild(
        el('tr', {}, [
          el('td', { text: `#${w.id}` }),
          el('td', { text: `${w.workerName} (${w.workerEmail})` }),
          el('td', { text: w.method.toUpperCase() }),
          el('td', { text: w.destinationAccount }),
          el('td', { className: 'tabular-nums', text: formatUsd(w.amountCents) }),
          el('td', {}, [statusBadge(w.status)]),
          actions,
        ])
      );
    }

    // Employers
    const empBody = document.getElementById('adm-employers-body');
    clearNode(empBody);
    for (const emp of employersData.employers || []) {
      const actions = el('td', { className: 'btn-row' });
      if (emp.verificationStatus !== 'verified') {
        actions.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: 'Verify Employer',
            onClick: async () => {
              try {
                await api(`/api/admin/employers/${emp.id}/verify`, {
                  method: 'POST',
                  body: JSON.stringify({ status: 'verified' }),
                });
                toast('Employer verified.', 'success');
                loadAdminDashboard();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          })
        );
      }
      if (emp.verificationStatus !== 'rejected') {
        actions.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-danger btn-sm',
            text: 'Reject',
            onClick: async () => {
              try {
                await api(`/api/admin/employers/${emp.id}/verify`, {
                  method: 'POST',
                  body: JSON.stringify({ status: 'rejected' }),
                });
                toast('Employer marked rejected.', 'info');
                loadAdminDashboard();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          })
        );
      }
      empBody.appendChild(
        el('tr', {}, [
          el('td', { text: `#${emp.id}` }),
          el('td', { text: emp.companyName }),
          el('td', { text: `${emp.ownerName} (${emp.ownerEmail})` }),
          el('td', {}, [statusBadge(emp.verificationStatus)]),
          el('td', { className: 'tabular-nums', text: formatUsd(emp.availableCampaignBalanceCents) }),
          actions,
        ])
      );
    }

    // Submissions
    const subsList = document.getElementById('adm-submissions-list');
    clearNode(subsList);
    for (const sub of subsData.submissions || []) {
      const card = el('div', { className: 'sub-item' }, [
        el('div', { className: 'sub-item-head' }, [
          el('div', {}, [
            el('strong', { text: `#${sub.id} · ${sub.taskTitle}` }),
            el('div', {
              className: 'subtle-text',
              text: `Worker: ${sub.workerName} (${sub.workerEmail}) · IP: ${sub.submissionIp || 'n/a'}`,
            }),
          ]),
          el('div', { className: 'btn-row' }, [
            el('strong', { className: 'tabular-nums', text: formatUsd(sub.rewardCentsSnapshot) }),
            statusBadge(sub.status),
          ]),
        ]),
        el('div', { text: sub.textProof || '(not yet submitted)' }),
      ]);
      if (sub.screenshotPath) {
        card.appendChild(await createAuthImagePreview(sub.screenshotPath));
      }
      if (sub.status === 'submitted') {
        const noteInput = el('input', { type: 'text', placeholder: 'Admin review note / rejection reason...' });
        card.appendChild(
          el('div', { className: 'btn-row' }, [
            noteInput,
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-sm',
              text: 'Approve Reward',
              onClick: async () => {
                try {
                  await api(`/api/admin/submissions/${sub.id}/approve`, {
                    method: 'POST',
                    body: JSON.stringify({ note: noteInput.value.trim() || undefined }),
                  });
                  toast('Reward approved.', 'success');
                  loadAdminDashboard();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-danger btn-sm',
              text: 'Reject',
              onClick: async () => {
                const note = noteInput.value.trim();
                if (note.length < 4) {
                  toast('Enter a rejection reason (4+ chars).', 'error');
                  return;
                }
                try {
                  await api(`/api/admin/submissions/${sub.id}/reject`, {
                    method: 'POST',
                    body: JSON.stringify({ note }),
                  });
                  toast('Submission rejected.', 'info');
                  loadAdminDashboard();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            }),
          ])
        );
      }
      subsList.appendChild(card);
    }

    // Tasks moderation
    const tasksBody = document.getElementById('adm-tasks-body');
    clearNode(tasksBody);
    for (const t of tasksData.tasks || []) {
      const actionTd = el('td', { className: 'btn-row' }, [
        el('button', {
          type: 'button',
          className: 'btn btn-outline btn-sm',
          text: t.status === 'active' ? 'Pause' : 'Activate',
          onClick: async () => {
            try {
              await api(`/api/admin/tasks/${t.id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status: t.status === 'active' ? 'paused' : 'active' }),
              });
              loadAdminDashboard();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-danger btn-sm',
          text: 'Remove',
          onClick: async () => {
            try {
              await api(`/api/admin/tasks/${t.id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'removed' }),
              });
              loadAdminDashboard();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }),
      ]);
      tasksBody.appendChild(
        el('tr', {}, [
          el('td', { text: `#${t.id}` }),
          el('td', { text: t.title }),
          el('td', { text: t.companyName }),
          el('td', { className: 'tabular-nums', text: formatUsd(t.rewardCents) }),
          el('td', { className: 'tabular-nums', text: `${t.approvedCount}/${t.maxQuantity}` }),
          el('td', {}, [statusBadge(t.status)]),
          actionTd,
        ])
      );
    }

    // Users
    const usersBody = document.getElementById('adm-users-body');
    clearNode(usersBody);
    for (const u of usersData.users || []) {
      const actions = el('td', { className: 'btn-row' });
      if (!u.accountVerified) {
        actions.appendChild(
          el('button', {
            type: 'button',
            className: 'btn btn-outline btn-sm',
            text: 'Verify KYC',
            onClick: async () => {
              try {
                await api(`/api/admin/users/${u.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ accountVerified: true, emailVerified: true }),
                });
                toast('User verified.', 'success');
                loadAdminDashboard();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          })
        );
      }
      actions.appendChild(
        el('button', {
          type: 'button',
          className: `btn btn-sm ${u.accountStatus === 'active' ? 'btn-danger' : 'btn-primary'}`,
          text: u.accountStatus === 'active' ? 'Suspend' : 'Reactivate',
          onClick: async () => {
            try {
              await api(`/api/admin/users/${u.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  accountStatus: u.accountStatus === 'active' ? 'suspended' : 'active',
                }),
              });
              loadAdminDashboard();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        })
      );

      usersBody.appendChild(
        el('tr', {}, [
          el('td', { text: `#${u.id}` }),
          el('td', { text: `${u.name} (${u.email})` }),
          el('td', { text: u.role }),
          el('td', { text: `Email: ${u.emailVerified ? 'Yes' : 'No'} · KYC: ${u.accountVerified ? 'Yes' : 'No'}` }),
          el('td', {}, [statusBadge(u.accountStatus)]),
          el('td', { className: 'tabular-nums', text: formatUsd(u.availableCents) }),
          actions,
        ])
      );
    }

    // Fraud signals
    const fraudList = document.getElementById('adm-fraud-signals');
    clearNode(fraudList);
    const f = overview.fraudSignals;
    fraudList.appendChild(
      el('div', { className: 'sub-item' }, [
        el('strong', { text: `Shared Submission IPs (${f.sharedSubmissionIps.length})` }),
        el('div', {
          className: 'subtle-text',
          text: f.sharedSubmissionIps.length
            ? f.sharedSubmissionIps.map((r) => `${r.submission_ip} (${r.distinct_users} accounts)`).join(', ')
            : 'No multi-account IP collisions detected.',
        }),
      ])
    );
    fraudList.appendChild(
      el('div', { className: 'sub-item' }, [
        el('strong', { text: `High-Rejection Workers (${f.highRejectWorkers.length})` }),
        el('div', {
          className: 'subtle-text',
          text: f.highRejectWorkers.length
            ? f.highRejectWorkers.map((r) => `${r.email}: ${r.rejected_count}/${r.total_count} rejected`).join(', ')
            : 'No elevated rejection anomalies detected.',
        }),
      ])
    );
    fraudList.appendChild(
      el('div', { className: 'sub-item' }, [
        el('strong', { text: `Failed Login Spikes (${f.failedLoginSpikes.length})` }),
        el('div', {
          className: 'subtle-text',
          text: f.failedLoginSpikes.length
            ? f.failedLoginSpikes.map((r) => `${r.email} (${r.failedLoginCount} failures)`).join(', ')
            : 'No brute-force anomalies detected.',
        }),
      ])
    );

    const admTxBody = document.getElementById('adm-transactions-body');
    clearNode(admTxBody);
    for (const t of txData.transactions || []) {
      admTxBody.appendChild(
        el('tr', {}, [
          el('td', { text: `#${t.id}` }),
          el('td', { text: t.userEmail }),
          el('td', { text: t.type }),
          el('td', { className: 'tabular-nums', text: formatUsd(t.amountCents) }),
          el('td', { text: t.description }),
          el('td', { text: formatDate(t.createdAt) }),
        ])
      );
    }

    const logsBody = document.getElementById('adm-logs-body');
    clearNode(logsBody);
    for (const log of logsData.logs || []) {
      logsBody.appendChild(
        el('tr', {}, [
          el('td', { text: formatDate(log.createdAt) }),
          el('td', { text: log.adminEmail || `Admin #${log.adminId}` }),
          el('td', { text: log.action }),
          el('td', { text: `${log.targetType}#${log.targetId}` }),
          el('td', { text: log.details }),
          el('td', { text: log.ipAddress || '—' }),
        ])
      );
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================
// ACCOUNT & NOTIFICATIONS
// ============================================================================
async function loadAccountView() {
  await refreshSession();
  if (!state.user) return;
  document.getElementById('acc-name').value = state.user.name || '';
  document.getElementById('acc-country').value = state.user.country || '';
  document.getElementById('acc-payout').value = state.user.payoutPreference || 'paypal';
  document.getElementById('acc-bio').value = state.user.bio || '';
  document.getElementById('acc-verification-summary').textContent =
    `Role: ${state.user.role.toUpperCase()} · Email Verified: ${state.user.emailVerified ? 'Yes' : 'Pending'} · Identity Verified: ${state.user.accountVerified ? 'Yes' : 'Pending'}`;
}

async function loadNotifications() {
  try {
    const data = await api('/api/users/notifications');
    const list = document.getElementById('notifications-list');
    clearNode(list);

    if (!data.notifications.length) {
      list.appendChild(el('div', { className: 'card subtle-text', text: 'No notifications yet.' }));
      return;
    }

    for (const n of data.notifications) {
      const card = el('div', { className: 'sub-item' }, [
        el('div', { className: 'sub-item-head' }, [
          el('strong', { text: n.title }),
          el('div', { className: 'btn-row' }, [
            statusBadge(n.isRead ? 'completed' : 'pending'),
            el('span', { className: 'subtle-text', text: formatDate(n.createdAt) }),
          ]),
        ]),
        el('p', { style: 'margin:0;', text: n.message }),
      ]);

      if (!n.isRead) {
        card.appendChild(
          el('div', {}, [
            el('button', {
              type: 'button',
              className: 'btn btn-outline btn-sm',
              text: 'Mark Read',
              onClick: async () => {
                await api(`/api/users/notifications/${n.id}/read`, { method: 'POST' });
                await refreshSession();
                loadNotifications();
              },
            }),
          ])
        );
      }
      list.appendChild(card);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================================
// EVENT BINDINGS & INITIALIZATION
// ============================================================================
function bindEvents() {
  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.jump));
  });
  document.getElementById('brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('marketplace');
  });

  document.getElementById('btn-open-login').addEventListener('click', () => openAuthModal('login'));
  document.getElementById('btn-open-register').addEventListener('click', () => openAuthModal('register'));
  document.getElementById('btn-open-admin-setup').addEventListener('click', () => openAuthModal('admin-setup'));
  document.getElementById('btn-close-auth-modal').addEventListener('click', closeAuthModal);
  document.getElementById('btn-close-task-modal').addEventListener('click', () => {
    document.getElementById('task-modal').classList.add('hidden');
  });
  document.getElementById('btn-close-proof-modal').addEventListener('click', () => {
    document.getElementById('proof-modal').classList.add('hidden');
  });

  document.getElementById('btn-account-view').addEventListener('click', () => switchView('account'));
  document.getElementById('btn-notifications').addEventListener('click', () => switchView('notifications'));
  document.getElementById('btn-go-verify').addEventListener('click', () => switchView('account'));
  document.getElementById('btn-refresh-admin').addEventListener('click', loadAdminDashboard);

  document.getElementById('btn-resend-verify').addEventListener('click', async () => {
    try {
      const res = await api('/api/auth/resend-verification', { method: 'POST' });
      toast(res.message, res.ok ? 'success' : 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    state.token = null;
    state.user = null;
    state.wallet = null;
    state.employer = null;
    if (window.TaskNovaFirebaseAuth) {
      await window.TaskNovaFirebaseAuth.signOutGoogle().catch(() => {});
    }
    updateChrome();
    switchView('marketplace');
    toast('Signed out securely.', 'info');
  });

  document.querySelectorAll('#auth-tabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
  });

  document.querySelectorAll('#admin-subtabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.adminTab;
      state.activeAdminTab = target;
      document.querySelectorAll('#admin-subtabs .subtab').forEach((b) => {
        b.classList.toggle('active', b.dataset.adminTab === target);
      });
      document.querySelectorAll('.admin-panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== `admin-panel-${target}`);
      });
    });
  });

  document.getElementById('reg-role').addEventListener('change', (e) => {
    document.getElementById('reg-company-wrap').classList.toggle('hidden', e.target.value !== 'employer');
  });

  // Marketplace filter listeners
  ['filter-search', 'filter-category', 'filter-difficulty', 'filter-sort'].forEach((id) => {
    document.getElementById(id).addEventListener(id === 'filter-search' ? 'input' : 'change', loadMarketplace);
  });

  // Withdrawal method dynamic label
  document.getElementById('wd-method').addEventListener('change', (e) => {
    const label = document.getElementById('wd-destination-label');
    const input = document.getElementById('wd-destination');
    if (e.target.value === 'paypal') {
      label.textContent = 'PayPal Email Address';
      input.placeholder = 'worker@example.com';
    } else if (e.target.value === 'usdt') {
      label.textContent = 'USDT Wallet Address (TRC20 T... or ERC20 0x...)';
      input.placeholder = 'T...';
    } else {
      label.textContent = 'Vodafone Cash Wallet Number (Egypt)';
      input.placeholder = '01012345678';
    }
  });

  // Auth forms
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      });
      state.token = data.token;
      await refreshSession();
      closeAuthModal();
      toast(`Welcome back, ${data.user.name}!`, 'success');
      switchView(data.user.role === 'admin' ? 'admin' : 'dashboard');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-google-signin').addEventListener('click', async () => {
    if (!window.TaskNovaFirebaseAuth) return;
    try {
      const fb = await window.TaskNovaFirebaseAuth.signInWithGoogle();
      state.token = fb.idToken;
      await api('/api/auth/firebase', { method: 'POST' });
      await refreshSession();
      closeAuthModal();
      toast('Signed in with Google!', 'success');
      switchView('dashboard');
    } catch (err) {
      toast(err.message || 'Google Sign-In failed.', 'error');
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const role = document.getElementById('reg-role').value;
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('reg-name').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
          role,
          companyName: role === 'employer' ? document.getElementById('reg-company').value : undefined,
        }),
      });
      state.token = data.token;
      await refreshSession();
      closeAuthModal();
      const mailNote = data.emailDispatch?.sent
        ? 'Check your email to verify your address.'
        : 'Account created. Configure SMTP_* to dispatch real verification emails.';
      toast(`Welcome to TaskNova! ${mailNote}`, 'success');
      switchView(role === 'employer' ? 'employer' : 'dashboard');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('admin-setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/setup-admin', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('adm-init-name').value,
          email: document.getElementById('adm-init-email').value,
          password: document.getElementById('adm-init-password').value,
          bootstrapKey: document.getElementById('adm-init-key').value || undefined,
        }),
      });
      state.token = data.token;
      await refreshSession();
      closeAuthModal();
      toast('Primary administrator account initialized.', 'success');
      switchView('admin');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: document.getElementById('forgot-email').value }),
      });
      toast(res.message, res.smtpConfigured ? 'success' : 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          token: document.getElementById('reset-token-input').value,
          newPassword: document.getElementById('reset-new-password').value,
        }),
      });
      toast(res.message, 'success');
      switchAuthTab('login');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Proof submission
  document.getElementById('submit-proof-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submissionId = document.getElementById('proof-submission-id').value;
    const formData = new FormData();
    formData.append('textProof', document.getElementById('proof-text').value);
    const file = document.getElementById('proof-file').files[0];
    if (file) {
      formData.append('screenshot', file);
    }

    try {
      await api(`/api/tasks/submissions/${submissionId}/submit`, {
        method: 'POST',
        body: formData,
      });
      document.getElementById('proof-modal').classList.add('hidden');
      toast('Proof submitted! Reward is now tracked in Pending Review.', 'success');
      await refreshSession();
      loadMySubmissions();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Withdrawal form
  document.getElementById('withdraw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          method: document.getElementById('wd-method').value,
          destinationAccount: document.getElementById('wd-destination').value,
          amountUsd: Number(document.getElementById('wd-amount').value),
        }),
      });
      document.getElementById('withdraw-form').reset();
      toast('Withdrawal request placed in queue for verification & payout.', 'success');
      await refreshSession();
      loadWallet();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Employer forms
  document.getElementById('employer-apply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/employers/apply', {
        method: 'POST',
        body: JSON.stringify({
          companyName: document.getElementById('emp-company').value,
          website: document.getElementById('emp-website').value,
          businessDescription: document.getElementById('emp-desc').value,
        }),
      });
      toast('Employer application submitted for admin verification.', 'success');
      await refreshSession();
      loadEmployerPortal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('emp-funding-intent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/employers/funding-intent', {
        method: 'POST',
        body: JSON.stringify({
          method: document.getElementById('fund-method').value,
          amountUsd: Number(document.getElementById('fund-amount').value),
          externalReference: document.getElementById('fund-ref').value,
        }),
      });
      document.getElementById('emp-funding-intent-form').reset();
      toast(res.message, 'success');
      loadEmployerPortal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-paypal-checkout').addEventListener('click', async () => {
    const amountUsd = Number(document.getElementById('fund-amount').value);
    if (!Number.isFinite(amountUsd) || amountUsd < 5) {
      toast('Enter a deposit amount of at least $5.00 USD first.', 'error');
      return;
    }
    try {
      const res = await api('/api/employers/funding-order/paypal', {
        method: 'POST',
        body: JSON.stringify({ amountUsd }),
      });
      const approveLink = res.order?.links?.find((l) => l.rel === 'approve')?.href;
      if (approveLink) {
        toast(`PayPal Order ${res.order.id} created. Approve URL: ${approveLink}`, 'success');
      } else {
        toast(`PayPal Order ${res.order?.id} created.`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('emp-create-task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/employers/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: document.getElementById('task-title').value,
          category: document.getElementById('task-category').value,
          difficulty: document.getElementById('task-difficulty').value,
          rewardUsd: Number(document.getElementById('task-reward').value),
          maxQuantity: Number(document.getElementById('task-qty').value),
          estimatedMinutes: Number(document.getElementById('task-minutes').value),
          description: document.getElementById('task-desc').value,
          instructions: document.getElementById('task-instructions').value,
          proofRequirements: document.getElementById('task-proof-req').value,
        }),
      });
      document.getElementById('emp-create-task-form').reset();
      toast('Draft task created! Fund and publish it below to make it live.', 'success');
      loadEmployerPortal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Admin credit verified deposit
  document.getElementById('adm-credit-deposit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const empId = Number(document.getElementById('adm-dep-emp-id').value);
    try {
      await api(`/api/admin/employers/${empId}/credit-verified-deposit`, {
        method: 'POST',
        body: JSON.stringify({
          providerMethod: document.getElementById('adm-dep-method').value,
          amountUsd: Number(document.getElementById('adm-dep-amount').value),
          externalReference: document.getElementById('adm-dep-ref').value,
        }),
      });
      document.getElementById('adm-credit-deposit-form').reset();
      toast('Verified employer campaign deposit credited.', 'success');
      loadAdminDashboard();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Account settings forms
  document.getElementById('account-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/users/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('acc-name').value,
          country: document.getElementById('acc-country').value,
          payoutPreference: document.getElementById('acc-payout').value,
          bio: document.getElementById('acc-bio').value,
        }),
      });
      await refreshSession();
      toast('Profile updated.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('verify-email-token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: document.getElementById('verify-token-input').value }),
      });
      document.getElementById('verify-token-input').value = '';
      await refreshSession();
      loadAccountView();
      toast(res.message, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-request-kyc').addEventListener('click', async () => {
    try {
      const res = await api('/api/users/request-verification', { method: 'POST' });
      toast(res.message, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/users/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: document.getElementById('pw-current').value,
          newPassword: document.getElementById('pw-new').value,
        }),
      });
      document.getElementById('change-password-form').reset();
      toast(res.message, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-mark-all-read').addEventListener('click', async () => {
    try {
      await api('/api/users/notifications/read-all', { method: 'POST' });
      await refreshSession();
      loadNotifications();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function handleQueryTokens() {
  const url = new URL(window.location.href);
  const verifyToken = url.searchParams.get('verify_token');
  const resetToken = url.searchParams.get('reset_token');

  if (verifyToken) {
    try {
      const res = await api('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: verifyToken }),
      });
      toast(res.message, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    url.searchParams.delete('verify_token');
    window.history.replaceState({}, '', url.toString());
  }

  if (resetToken) {
    openAuthModal('reset');
    document.getElementById('reset-token-input').value = resetToken;
    url.searchParams.delete('reset_token');
    window.history.replaceState({}, '', url.toString());
  }
}

async function bootstrap() {
  populateCategorySelects();
  bindEvents();
  await handleQueryTokens();
  await refreshSession();
  await loadMarketplace();
}

bootstrap();
