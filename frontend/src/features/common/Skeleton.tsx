import { MorphLoader } from "./MorphLoader.js";

// Loading placeholder. Originally gray skeleton bars (progress/skeleton);
// replaced wholesale by the morph-loader ring after user feedback — every
// view that used to flash skeleton bars now shows the same elegant spinner
// as the ksqlDB module, with zero per-view changes (the export contract is
// "loading placeholder", so the implementation swap upgrades all call sites).
// The rows/className props are kept for call-site compatibility: rows is
// accepted but no longer rendered (the spinner is size-fixed), className
// still controls the outer box.
interface SkeletonLinesProps {
  rows?: number;
  className?: string;
}

export function SkeletonLines({ className = "" }: SkeletonLinesProps) {
  return (
    <div className={`morph-center ${className}`} aria-busy="true">
      <MorphLoader status="loading" />
    </div>
  );
}
