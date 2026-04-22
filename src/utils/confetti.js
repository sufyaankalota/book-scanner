/**
 * CSS-based confetti celebration for scan milestones.
 * No external libraries — creates temporary DOM elements.
 */

const MILESTONES = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000];
const COLORS = ['#EF4444', '#3B82F6', '#EAB308', '#22C55E', '#F97316', '#A855F7', '#EC4899', '#14B8A6'];

let lastTriggered = 0;

export function checkMilestone(count) {
  const milestone = MILESTONES.find((m) => count >= m && m > lastTriggered);
  if (milestone) {
    lastTriggered = milestone;
    return milestone;
  }
  return null;
}

export function triggerConfetti() {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.5;
    const size = 6 + Math.random() * 8;
    const rotation = Math.random() * 360;
    piece.style.cssText = `
      position:absolute;top:-20px;left:${left}%;width:${size}px;height:${size * 0.6}px;
      background:${color};border-radius:2px;transform:rotate(${rotation}deg);
      animation:confettiFall ${2 + Math.random()}s ease-in ${delay}s forwards;
    `;
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 4000);
}

export function getMilestoneMessage(milestone) {
  if (milestone >= 20000) return '🏆 20,000 SCANS! LEGENDARY!';
  if (milestone >= 15000) return '🔥 15,000! UNSTOPPABLE!';
  if (milestone >= 10000) return '⭐ 10,000! INCREDIBLE!';
  if (milestone >= 5000) return '🎉 5,000 SCANS! AMAZING!';
  if (milestone >= 3000) return '💪 3,000! CRUSHING IT!';
  if (milestone >= 2000) return '🚀 2,000 SCANS!';
  if (milestone >= 1000) return '🎯 1,000 SCANS!';
  return '✨ 500 SCANS!';
}
