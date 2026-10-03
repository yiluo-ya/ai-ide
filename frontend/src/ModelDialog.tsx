/**
 * 模型配置浮层（2026-10-03 用户要求）：从「设置」里提出来，与设置平级。
 *
 * 内容仍是 ModelSettings（provider / base URL / API key / 模型 id），这里只负责套一层 Dialog。
 */
import { Dialog } from './Dialog';
import { ModelSettings } from './ModelSettings';
import { useI18n } from './i18n';
import './agent.css';

export function ModelDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog title={t('settings.model')} onClose={onClose} wide>
      <ModelSettings />
    </Dialog>
  );
}
