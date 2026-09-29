export const BUILDER_ID_SERVICE_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

export const KIRO_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type KiroEffort = (typeof KIRO_EFFORTS)[number];

