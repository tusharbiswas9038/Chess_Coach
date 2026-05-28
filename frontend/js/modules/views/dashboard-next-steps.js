// Pure data layer for the dashboard "Next best step" panel.
//
// Takes statsData + weeklyFocus, returns up to 3 candidate steps ordered by
// score with duplicates removed. No DOM, no closures — easy to test and to
// move into an RN port unchanged.

export function buildNextSteps(statsData, weeklyFocus = null) {
  const dueCount = Number(statsData?.drills_due || 0);
  const pending = Number(statsData?.games?.pending || 0);
  const hRate = Number(statsData?.hanging_piece_rate || 0) * 100;
  const bpg = Number(statsData?.blunders_per_game || 0);
  const primaryFocus = weeklyFocus?.primary_focus;
  const focusType = primaryFocus?.type ? primaryFocus.type.replace('_', ' ') : null;
  const focusPhase = primaryFocus?.phase || 'all phases';

  const candidates = [];
  if (dueCount > 0) {
    candidates.push({
      title: `Clear ${Math.min(dueCount, 15)} due drill${dueCount === 1 ? '' : 's'}`,
      rationale:
        dueCount > 10
          ? 'Your review queue is large enough to block new learning. Finish the due items first.'
          : 'Spaced-repetition positions are time-sensitive and come from your own mistakes.',
      target: 'drills',
      score: 100 + dueCount,
      badge: 'Drills',
    });
  }
  if (primaryFocus) {
    candidates.push({
      title: `Attack ${focusType} in ${focusPhase}`,
      rationale: weeklyFocus?.actions?.[0] || 'This is the strongest current pattern in your recent games.',
      target: 'mistakes',
      score: 86,
      badge: 'Focus',
    });
  }
  if (hRate >= 40) {
    candidates.push({
      title: 'Run a piece-safety review',
      rationale: `${hRate.toFixed(1)}% hanging-piece rate is high enough to cost games before strategy matters.`,
      target: 'mistakes',
      score: 82,
      badge: 'Leak',
    });
  }
  if (bpg >= 3) {
    candidates.push({
      title: 'Practice a one-move blunder check',
      rationale: `${bpg.toFixed(1)} blunders per game means the fastest gain is reducing one tactical miss.`,
      target: 'drills',
      score: 78,
      badge: 'Tactics',
    });
  }
  if (pending > 0) {
    candidates.push({
      title: `Analyze ${pending} pending game${pending === 1 ? '' : 's'}`,
      rationale: 'The dashboard is missing fresh signals from games that are already in the database.',
      target: 'games',
      score: 62 + Math.min(pending, 20),
      badge: 'Backlog',
    });
  }
  candidates.push({
    title: 'Review the latest critical game',
    rationale: 'One concrete mistake reviewed deeply is better than scanning ten games loosely.',
    target: 'games',
    score: 50,
    badge: 'Review',
  });
  candidates.push({
    title: 'Ask coach for one correction rule',
    rationale: 'Convert the pattern into a short rule you can use before your next game.',
    target: 'coach',
    score: 42,
    badge: 'Coach',
  });

  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((step, index, arr) => arr.findIndex((item) => item.title === step.title) === index)
    .slice(0, 3);
}
