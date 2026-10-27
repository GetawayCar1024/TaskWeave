import type { useDialog, useMessage } from 'naive-ui';
import { i18n } from '../i18n';
import { api, errorMessage } from './api';

/** Confirm, then move the problem to the trash. Resolves true when deleted. */
export function confirmDeleteProblem(dialog: ReturnType<typeof useDialog>, message: ReturnType<typeof useMessage>, id: string, contests: string[] = []): Promise<boolean> {
  const t = i18n.global.t as (k: string, p?: Record<string, unknown>) => string;
  return new Promise((resolve) => {
    dialog.warning({
      title: t('problem.deleteTitle', { id }),
      content: [t('problem.deleteBody'), contests.length ? t('problem.deleteInContests', { list: contests.join('、') }) : ''].filter(Boolean).join('\n'),
      positiveText: t('problem.delete'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        try {
          const r = await api.deleteProblem(id);
          message.success(t('problem.deleted', { path: r.trash }), { duration: 6000 });
          resolve(true);
        } catch (e) {
          message.error(errorMessage(e));
          resolve(false);
        }
      },
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    });
  });
}

/** Confirm, then recycle the contest folder (its referenced problems stay). */
export function confirmDeleteContest(dialog: ReturnType<typeof useDialog>, message: ReturnType<typeof useMessage>, id: string, title: string): Promise<boolean> {
  const t = i18n.global.t as (k: string, p?: Record<string, unknown>) => string;
  return new Promise((resolve) => {
    dialog.warning({
      title: t('contest.deleteTitle', { name: title }),
      content: t('contest.deleteConfirm'),
      positiveText: t('contest.delete'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        try {
          await api.deleteContest(id);
          message.success(t('contest.deleted'));
          resolve(true);
        } catch (e) {
          message.error(errorMessage(e));
          resolve(false);
        }
      },
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    });
  });
}
