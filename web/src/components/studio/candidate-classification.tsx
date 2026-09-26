import { Badge } from "@/components/ui/badge";
import {
  getCandidateClassification,
  candidateClassificationLabels,
  candidateClassificationHelp,
  candidateClassificationDisclaimer,
  type CandidateClassification,
} from "@/lib/studio-candidate-classification";

export function CandidateClassificationNotice({
  candidate,
}: {
  candidate: { classification?: CandidateClassification };
}) {
  const classification = getCandidateClassification(candidate);
  return (
    <div aria-label="아이템 추천 분류" className="space-y-1.5 text-xs leading-6">
      <Badge variant="outline">{candidateClassificationLabels[classification]}</Badge>
      <p>{candidateClassificationHelp[classification]}</p>
      <p className="text-muted-foreground">{candidateClassificationDisclaimer}</p>
    </div>
  );
}
