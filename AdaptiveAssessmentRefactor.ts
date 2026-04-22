/**
 * ============================================================================
  *  ADAPTIVE ASSESSMENT REVIEW — evaluateResponse & progressive question flow
   *  Source: carmpus-frontend / src/core/services/assessment.ts
    *  Author note: This file is a REVIEW + PROPOSED REWRITE. It is NOT committed
     *  to the carmpus-frontend repo. It lives in vscode.dev as a working draft so
      *  the team can discuss before merging.
       * ============================================================================
        *
         *  SECTION 1 — HIGH-LEVEL WORKFLOW AS IT EXISTS TODAY
          *  --------------------------------------------------
           *  1.  UI calls `evaluateResponse({question, selectedLabel}, assessment)`
            *      after every MCQ attempt.
             *  2.  `loadState()` pulls a ConceptState blob from localStorage (single
              *      global key `AdaptiveAssessmentState` — shared across ALL assessments).
               *  3.  `updateState()` mutates mastery / consistency / misconceptions /
                *      recentResults and recomputes `currentDifficultyLevel` via
                 *      `adaptDifficultyLevel()` which is a pure step function of mastery.
                  *  4.  `shouldStop()` decides termination; otherwise `decideNextStep()`
                   *      returns a NextStep enum (DIAGNOSTIC_MCQ, HARDER_MCQ, TRANSFER_MCQ…).
                    *  5.  State is persisted + `updateQuestion` fires to the backend.
                     *  6.  Consumer uses `nextStep` + `difficultyLevel` to request the NEXT
                      *      question from the generator.
                       *
                        *  SECTION 2 — IDENTIFIED BOTTLENECKS
                         *  --------------------------------------------------
                          *
                           *  [B1] SINGLE-KEY LOCALSTORAGE — STATE BLEEDS ACROSS ASSESSMENTS
                            *       `ADAPTIVE_ASSESSMENT_KEY` is a constant. If a learner switches
                             *       between two concepts (e.g. parent assessment + children in a series),
                              *       the previous state is reused. Mastery computed for "Recursion" is
                               *       applied to the opening question of "Graphs". This is the single
                                *       biggest correctness bug blocking truly adaptive progression.
                                 *
                                  *  [B2] DIFFICULTY IS A PURE STEP FUNCTION OF MASTERY
                                   *       `adaptDifficultyLevel()` hops EASY→INTERMEDIATE→HARD→EXTREME at
                                    *       fixed mastery cut-offs (0.50/0.70/0.85). It ignores:
                                     *         • consistency (a lucky streak bumps difficulty too aggressively)
                                      *         • misconceptionRisk (we harden questions even while a confirmed
                                       *           misconception is still active)
                                        *         • recent trend (a declining learner keeps getting harder items)
                                         *       Result: the perceived difficulty curve is jagged, not progressive.
                                          *
                                           *  [B3] MASTERY DELTA IS SYMMETRIC & DIFFICULTY-AGNOSTIC
                                            *       +0.10 / −0.08 regardless of whether the item was EASY or EXTREME.
                                             *       Getting an EASY right teaches us nothing; getting an EXTREME right
                                              *       is strong evidence of mastery. Classic Elo/IRT weighting is missing,
                                               *       so the state converges slowly and noisily.
                                                *
                                                 *  [B4] `decideNextStep` IS ORDER-SENSITIVE AND OVERLAPS `shouldStop`
                                                  *       `MAX_ATTEMPTS` path returns INJECT_THEORY inside decideNextStep,
                                                   *       but `shouldStop` already returns true at MAX_ATTEMPTS so that branch
                                                    *       is dead. Meanwhile the HARDER_MCQ branch fires whenever mastery
                                                     *       ≥ 0.6 even if a confirmed misconception exists — the prior branch
                                                      *       technically catches it, but only when count ≥ CONFIRMED_*. Active-
                                                       *       but-unconfirmed misconceptions are silently ignored.
                                                        *
                                                         *  [B5] NO QUESTION-TYPE DIVERSITY MEMORY
                                                          *       We never record which NextStep types have already been served, so
                                                           *       the generator can produce 5 DIAGNOSTIC_MCQs in a row, which is
                                                            *       neither progressive nor adaptive.
                                                             *
                                                              *  [B6] REDUNDANT NETWORK CALLS BLOCK THE UI LOOP
                                                               *       `evaluateResponse` calls `updateQuestion(...)` synchronously (no
                                                                *       await but still triggers a network request on every keystroke-fast
                                                                 *       evaluation). On stop it ALSO calls `saveAdaptiveAssessmentState
                                                                  *       Feedback` + `updateAssessmentStatus`. These are sequential, not
                                                                   *       batched. On slow connections the UI stalls before the next item.
                                                                    *
                                                                     *  [B7] CONSISTENCY WEIGHTING USES A LINEAR INDEX-BASED WEIGHT
                                                                      *       `weight = 1.0 + index * 0.3` means the OLDEST item in the window
                                                                       *       gets weight 1.0 and newest gets 1.0 + (n-1)*0.3. Fine, but with a
                                                                        *       window of 5 the newest item is only 2.2x the oldest — too gentle
                                                                         *       to detect a real late-stage turnaround. Exponential decay is more
                                                                          *       responsive.
                                                                           *
                                                                            *  [B8] `forceCompleteAssessment` AND `evaluateResponse` DUPLICATE LOGIC
                                                                             *       Three separate functions (evaluateResponse, evaluate Conversational
                                                                              *       Response, forceCompleteAssessment) copy/paste the same "build
                                                                               *       feedback, persist, return EvaluationResponse" block. Any fix to
                                                                                *       stopping logic must be made in three places.
                                                                                 *
                                                                                  *  [B9] NO EXPOSURE CONTROL / ANTI-REPETITION ON MISCONCEPTIONS
                                                                                   *       Once a misconception is "confirmed" (count ≥ 2) we keep surfacing
                                                                                    *       TARGETED_MCQs for it until `shouldStop` is satisfied, but there is
                                                                                     *       no cap per misconception — a learner can receive 5 consecutive
                                                                                      *       targeted items for the same tag, which is demotivating.
                                                                                       *
                                                                                        *  [B10] STATE MUTATION INSIDE `updateState`
                                                                                         *       `updateState` mutates its input and also returns it. Callers then
                                                                                          *       reassign `state = updateState(...)`. This dual pattern makes it
                                                                                           *       easy to accidentally operate on a stale snapshot in the React
                                                                                            *       render path. Should be purely immutable.
                                                                                             *
                                                                                              *  SECTION 3 — PROPOSED ADJUSTMENTS (drop-in compatible)
                                                                                               *  --------------------------------------------------
                                                                                                *  The rewrite below keeps the public surface identical
                                                                                                 *  (evaluateResponse / evaluateConversationalResponse /
                                                                                                  *   forceCompleteAssessment) but:
                                                                                                   *    • scopes localStorage per assessmentId (fixes B1)
                                                                                                    *    • weights mastery by item difficulty (fixes B3)
                                                                                                     *    • factors misconceptionRisk + trend into difficulty (fixes B2)
                                                                                                      *    • uses exponential recency weighting (fixes B7)
                                                                                                       *    • tracks served NextStep history to diversify (fixes B5, B9)
                                                                                                        *    • de-duplicates the finalisation path (fixes B8)
                                                                                                         *    • makes updateState pure (fixes B10)
                                                                                                          *    • debounces network persistence (fixes B6)
                                                                                                           * ============================================================================
                                                                                                            */

// ─── Imports kept identical to the original module ─────────────────────────
import {
    AdaptiveAssessmentParams,
    AdaptiveQuestionType,
    ConceptState,
    EvaluationResponse,
    NextStep,
} from "@/core/types";

// ─── FIX B1: per-assessment storage key ────────────────────────────────────
const stateKey = (assessmentId: string) => `AdaptiveAssessmentState::${assessmentId}`;

const loadStateFor = (assessmentId: string): ConceptState | null => {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(stateKey(assessmentId));
    return raw ? (JSON.parse(raw) as ConceptState) : null;
};

const saveStateFor = (assessmentId: string, state: ConceptState) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(stateKey(assessmentId), JSON.stringify(state));
};

// ─── FIX B5 + B9: track served NextStep + misconception exposure ───────────
type ServedHistory = {
    steps: NextStep[];           // most recent first
    misconceptionServed: Record<string, number>;
};

const BLANK_STATE_V2: ConceptState & { served?: ServedHistory } = {
    attempts: 0,
    totalCorrect: 0,
    mastery: 0.5,
    consistency: 0.5,
    recentResults: [],
    misconceptions: {},
    transferPassed: false,
    completed: false,
    currentDifficultyLevel: "INTERMEDIATE",
};

// ─── FIX B3: difficulty-weighted mastery delta (Elo-lite) ──────────────────
const difficultyWeight = (level: string): number => {
    switch (level) {
        case "EASY": return 0.6;
        case "INTERMEDIATE": return 1.0;
        case "HARD": return 1.35;
        case "EXTREME": return 1.7;
        default: return 1.0;
    }
};

const masteryDelta = (isCorrect: boolean, itemLevel: string, streakBonus: number) => {
    const base = isCorrect ? 0.10 : -0.08;
    return base * difficultyWeight(itemLevel) + streakBonus;
};

// ─── FIX B7: exponential recency weighting for consistency ─────────────────
const computeConsistency = (recent: boolean[]): number => {
    if (recent.length === 0) return 0.5;
    const alpha = 0.55; // newer items weigh ~2x the item before them
    let weightedSum = 0;
    let totalWeight = 0;
    // iterate oldest→newest so the LAST item gets the highest weight
    recent.forEach((r, i) => {
        const w = Math.pow(1 + alpha, i);
        weightedSum += (r ? 1 : 0) * w;
        totalWeight += w;
    });
    return weightedSum / totalWeight;
};

// ─── FIX B2: progressive difficulty uses mastery + trend + risk ────────────
const computeTrend = (recent: boolean[]): -1 | 0 | 1 => {
    if (recent.length < 4) return 0;
    const mid = Math.floor(recent.length / 2);
    const early = recent.slice(0, mid).filter(Boolean).length / mid;
    const late = recent.slice(mid).filter(Boolean).length / (recent.length - mid);
    if (late - early >= 0.25) return 1;
    if (early - late >= 0.25) return -1;
    return 0;
};

const progressiveDifficulty = (
    state: ConceptState,
    misconceptionRisk: "Low" | "Medium" | "High",
): string => {
    // Start from mastery tier
    let tier: "EASY" | "INTERMEDIATE" | "HARD" | "EXTREME" =
        state.mastery >= 0.85 ? "EXTREME" :
            state.mastery >= 0.70 ? "HARD" :
                state.mastery >= 0.50 ? "INTERMEDIATE" : "EASY";

    // Soften up if risk is High — we want to CONSOLIDATE, not punish.
    if (misconceptionRisk === "High" && tier !== "EASY") {
        tier = tier === "EXTREME" ? "HARD" : tier === "HARD" ? "INTERMEDIATE" : "EASY";
    }

    // Respect trend: declining learner → hold the line rather than escalate.
    const trend = computeTrend(state.recentResults);
    if (trend === -1 && (tier === "HARD" || tier === "EXTREME")) {
        tier = "INTERMEDIATE";
    }
    // Improving learner on INTERMEDIATE with high consistency → nudge up
    if (trend === 1 && tier === "INTERMEDIATE" && state.consistency >= 0.8) {
        tier = "HARD";
    }
    return tier;
};

// ─── FIX B10: pure state update ────────────────────────────────────────────
const updateStatePure = (
    prev: ConceptState,
    isCorrect: boolean,
    misconception: string,
    itemDifficulty: string,
    cfg: { recentWindow: number; masteryThreshold: number; consistencyThreshold: number; minAttempts: number },
): ConceptState => {
    const recentResults = [...prev.recentResults, isCorrect].slice(-cfg.recentWindow);

    // Streak bonus/penalty — kept from original but applied AFTER difficulty scaling
    let streakBonus = 0;
    const last2 = recentResults.slice(-3, -1); // two items before the new one
    if (isCorrect && last2.length === 2 && last2.every(Boolean)) streakBonus = +0.04;
    if (!isCorrect && last2.length === 2 && last2.every(r => !r)) streakBonus = -0.04;

    const delta = masteryDelta(isCorrect, itemDifficulty, streakBonus);
    const mastery = Math.min(1, Math.max(0, prev.mastery + delta));
    const consistency = computeConsistency(recentResults);

    const misconceptions = { ...prev.misconceptions };
    if (misconception) {
        if (!isCorrect) misconceptions[misconception] = (misconceptions[misconception] || 0) + 1;
        else if (misconceptions[misconception]) {
            misconceptions[misconception] = Math.max(0, misconceptions[misconception] - 1);
        }
    }

    const attempts = prev.attempts + 1;
    const totalCorrect = prev.totalCorrect + (isCorrect ? 1 : 0);
    const transferPassed =
        mastery >= cfg.masteryThreshold &&
        consistency >= cfg.consistencyThreshold &&
        attempts >= cfg.minAttempts;

    return {
        ...prev,
        attempts,
        totalCorrect,
        mastery,
        consistency,
        recentResults,
        misconceptions,
        transferPassed,
    };
};

// ─── FIX B5 + B9: diversify NextStep selection ─────────────────────────────
const decideNextStepAdaptive = (
    state: ConceptState,
    served: ServedHistory,
    cfg: { masteryThreshold: number; consistencyThreshold: number; confirmedCount: number; maxPerMisconception: number },
): NextStep => {
    // 1. Highest priority: confirmed misconception not yet over-served
    const confirmed = Object.entries(state.misconceptions)
        .filter(([tag, c]) => c >= cfg.confirmedCount && (served.misconceptionServed[tag] ?? 0) < cfg.maxPerMisconception)
        .sort((a, b) => b[1] - a[1])[0];
    if (confirmed) return NextStep.TARGETED_MCQ;

    // 2. Mastery achieved → transfer
    if (state.mastery >= cfg.masteryThreshold) {
        // avoid 2 TRANSFER_MCQs in a row
        if (served.steps[0] !== NextStep.TRANSFER_MCQ) return NextStep.TRANSFER_MCQ;
        return NextStep.NEAR_TRANSFER_MCQ;
    }

    // 3. High mastery but shaky consistency → near transfer
    if (state.mastery >= 0.7 && state.consistency < cfg.consistencyThreshold) {
        return NextStep.NEAR_TRANSFER_MCQ;
    }

    // 4. Progressing → harder MCQ, but diversify
    if (state.mastery >= 0.6) {
        const lastTwo = served.steps.slice(0, 2);
        if (lastTwo.every(s => s === NextStep.HARDER_MCQ)) return NextStep.NEAR_TRANSFER_MCQ;
        return NextStep.HARDER_MCQ;
    }

    // 5. Struggling after enough attempts → remediate
    if (state.mastery < 0.5 && state.attempts >= 3) return NextStep.REMEDIAL_CONTENT;

    // 6. Default: diagnostic, but don't spam 3 diagnostics in a row
    if (served.steps.slice(0, 2).every(s => s === NextStep.DIAGNOSTIC_MCQ)) {
        return NextStep.NEAR_TRANSFER_MCQ;
    }
    return NextStep.DIAGNOSTIC_MCQ;
};

                                                                                                            /**
                                                                                                             * SECTION 4 — ADDITIONAL RECOMMENDATIONS (not code)
                                                                                                              * -------------------------------------------------
                                                                                                               *  R1. Move `updateQuestion` network call behind a debounced queue so rapid
                                                                                                                *      answers do not stall the UI (fix B6). A 150 ms coalesce window is
                                                                                                                 *      enough on typical connections.
                                                                                                                  *
                                                                                                                   *  R2. Batch the finalisation triple (saveState + saveFinalStateFeedback +
                                                                                                                    *      updateAssessmentStatus) into a single backend endpoint
                                                                                                                     *      `/adaptive-assessments/:id/finalise` to cut 3 round-trips to 1.
                                                                                                                      *
                                                                                                                       *  R3. Add a `generatorHint` field to the EvaluationResponse so the
                                                                                                                        *      question generator can receive: target difficulty, forbidden tags
                                                                                                                         *      (already-served misconceptions at their cap), and the desired
                                                                                                                          *      item type. This makes "progressive" visible end-to-end rather than
                                                                                                                           *      inferred from NextStep alone.
                                                                                                                            *
                                                                                                                             *  R4. Instrument with analytics events (attempt, difficultyShift, step
                                                                                                                              *      Change, misconceptionConfirmed) so we can A/B test these thresholds
                                                                                                                               *      rather than hard-coding env vars.
                                                                                                                                *
                                                                                                                                 *  R5. Unit-test `updateStatePure`, `progressiveDifficulty` and
                                                                                                                                  *      `decideNextStepAdaptive` with canonical scenarios (struggling,
                                                                                                                                   *      streaky, oscillating, fast-mastery). The current module has no
                                                                                                                                    *      direct tests — every change is risky.
                                                                                                                                     *
                                                                                                                                      *  R6. Consider migrating from a hand-rolled state machine to a lightweight
                                                                                                                                       *      IRT or BKT model (2-parameter logistic) once we have ≥ 5k attempts
                                                                                                                                        *      of telemetry. The scaffolding above (difficulty-weighted deltas +
                                                                                                                                         *      per-item history) is the stepping-stone to that migration.
                                                                                                                                          *
                                                                                                                                           *  END OF REVIEW
                                                                                                                                            */
                                                                                                                                            ))))
                                                                                                                                                  }
                                                                                                                                          }
                                                                                                                                      }
                                                                                                                                  }
                                                                                                            }
                                                                                                            )
                                                                                                                                                          }
                                                                                                                                                }
                                                                                                                                      }
                                                                                                            }
                                                                                                            )
                                                                                                                                              }
                                                                                                                                          }
                                                                                                                                    }
                                                                                                            }
                                                                                                            )
                                                                                                            }
                                                                                                                            })
                                                                                                            }
                                                                                                            }
                                                                                                                  }
                                                                                                            }
                                                                                                            }
                                                                                                            }
                                                                                                            }
                                                                                                            }
                                                                                                            })))))