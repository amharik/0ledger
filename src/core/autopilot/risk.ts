import type { ClassificationSuggestion, MoneyEvent } from '../model';

export type RiskBand = 'low' | 'medium' | 'high';

export interface MoneyEventRisk {
  score: number;
  band: RiskBand;
  reasons: string[];
}

export function classifyMoneyEventRisk(input: {
  event: MoneyEvent;
  suggestion?: ClassificationSuggestion | undefined;
  amountPercentile?: number;
  duplicateLikelihood?: boolean;
}): MoneyEventRisk {
  const reasons: string[] = [];
  const confidence = Math.max(0, Math.min(1, input.suggestion?.confidence ?? input.event.confidence));
  let score = (1 - confidence) * 40;
  if (confidence < 0.7) reasons.push(`Low classification confidence (${Math.round(confidence * 100)}%)`);

  if (input.suggestion?.taxHint) {
    score += 20;
    reasons.push(`Tax-sensitive: ${input.suggestion.taxHint}`);
  }
  if (input.event.direction === 'out' && !input.event.attachmentId) {
    score += 20;
    reasons.push('Missing supporting document');
  }
  if (input.duplicateLikelihood) {
    score += 10;
    reasons.push('Possible duplicate');
  }
  const percentile = Math.max(0, Math.min(1, input.amountPercentile ?? 0));
  score += percentile * 10;
  if (percentile >= 0.9) reasons.push('Large amount for this period');
  if (reasons.length === 0) reasons.push('Amount and classification look routine');

  score = Math.round(Math.max(0, Math.min(100, score)));
  return {
    score,
    band: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low',
    reasons,
  };
}
