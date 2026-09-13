export type SkillPublication = {
    target_path: string;
    previous_digest: string;
    published_digest: string;
    backup_path: string;
};
export declare function publishSkill(args: {
    sourceRoot: string;
    targetPath: string;
    expectedDigest: string;
    content: string;
    backupsDir: string;
    proposalId: string;
    allowExternalWrite: unknown;
    onBeforeFinalCheck?: () => Promise<void>;
}): Promise<SkillPublication>;
export declare function rollbackSkillPublication(args: {
    targetPath: string;
    expectedDigest: string;
    publishedDigest: string;
    backupPath: string;
    allowExternalWrite: unknown;
}): Promise<void>;
