export interface Opportunity {
  id: number;
  name: string;
  distance: number;
  averageGrade: number;
  elevationGain: number;
  komTime: number;
  predictedTime: number;
  marginSeconds: number;
  score: number;
  confidence: number;
}