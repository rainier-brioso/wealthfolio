import { Icons } from "@wealthfolio/ui/components/ui/icons";

export const INVERSIS_MATCH_STATES = {
  unmatched: {
    card: "border-s-destructive",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    icon: Icons.AlertCircle,
  },
  matched: {
    card: "border-s-success",
    badge: "border-success-subtle-border bg-success-subtle text-success-subtle-foreground",
    icon: Icons.CheckCircle,
  },
};
