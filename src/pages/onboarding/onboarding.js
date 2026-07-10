/**
 * FlowCapture Onboarding Wizard
 * ===============================
 * Multi-step first-run guide for HACSM staff.
 * Opens automatically on first install or when triggered from the popup help button.
 */

(function () {
  'use strict';

  const TOTAL_STEPS = 6;
  let currentStep = 0;

  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const progressFill = document.getElementById('progressFill');
  const stepDotsContainer = document.getElementById('stepDots');

  // ─── Build step dots ──────────────────────────────────────
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'step-dot' + (i === 0 ? ' active' : '');
    dot.dataset.step = i;
    dot.setAttribute('aria-label', `Go to onboarding step ${i + 1} of ${TOTAL_STEPS}`);
    if (i === 0) dot.setAttribute('aria-current', 'step');
    dot.addEventListener('click', () => goToStep(i));
    stepDotsContainer.appendChild(dot);
  }

  // ─── Navigation ───────────────────────────────────────────
  function goToStep(index) {
    if (index < 0 || index >= TOTAL_STEPS) return;

    // Hide current step
    const activeStep = document.querySelector('.step.active');
    if (activeStep) activeStep.classList.remove('active');

    // Show target step
    const targetStep = document.querySelector(`.step[data-step="${index}"]`);
    if (targetStep) targetStep.classList.add('active');

    currentStep = index;
    updateNav();
    updateDots();
    updateProgress();
  }

  function updateNav() {
    // Back button
    prevBtn.style.visibility = currentStep === 0 ? 'hidden' : 'visible';

    // Next button
    if (currentStep === TOTAL_STEPS - 1) {
      nextBtn.textContent = '';
      nextBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Start Using FlowCapture
      `;
      nextBtn.className = 'btn btn-success';
    } else if (currentStep === 0) {
      nextBtn.innerHTML = `
        Get Started
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      `;
      nextBtn.className = 'btn btn-primary';
    } else {
      nextBtn.innerHTML = `
        Next
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      `;
      nextBtn.className = 'btn btn-primary';
    }
  }

  function updateDots() {
    const dots = stepDotsContainer.querySelectorAll('.step-dot');
    dots.forEach((dot, i) => {
      dot.classList.remove('active', 'completed');
      dot.removeAttribute('aria-current');
      if (i === currentStep) {
        dot.classList.add('active');
        dot.setAttribute('aria-current', 'step');
      } else if (i < currentStep) {
        dot.classList.add('completed');
      }
    });
  }

  function updateProgress() {
    const pct = ((currentStep) / (TOTAL_STEPS - 1)) * 100;
    progressFill.style.width = pct + '%';
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep === TOTAL_STEPS - 1) {
      // Mark onboarding complete and close
      completeOnboarding();
    } else {
      goToStep(currentStep + 1);
    }
  });

  prevBtn.addEventListener('click', () => {
    goToStep(currentStep - 1);
  });

  // ─── Keyboard navigation ─────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (currentStep === TOTAL_STEPS - 1) {
        completeOnboarding();
      } else {
        goToStep(currentStep + 1);
      }
    } else if (e.key === 'ArrowLeft') {
      goToStep(currentStep - 1);
    }
  });

  // ─── Complete onboarding ──────────────────────────────────
  function completeOnboarding() {
    // Save flag so we don't show again
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ flowcapture_onboarding_complete: true });
    }

    // Close the tab — user will use the extension via the popup icon
    window.close();

    // Fallback: if window.close() doesn't work (some Chrome policies), show a message
    setTimeout(() => {
      document.getElementById('wizard').innerHTML = `
        <div style="text-align:center;padding:60px 40px">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <h1 style="margin-top:16px;font-size:24px;color:#1e1e2e">Setup Complete!</h1>
          <p style="margin-top:10px;color:#64748b;font-size:15px">
            Click the <strong>FlowCapture icon</strong> in your toolbar to start capturing SOPs.
          </p>
          <p style="margin-top:8px;color:#94a3b8;font-size:13px">You can close this tab.</p>
        </div>
      `;
    }, 300);
  }

  // ─── Init ─────────────────────────────────────────────────
  updateNav();
  updateProgress();
})();
