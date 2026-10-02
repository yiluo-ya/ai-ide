/**
 * 隐私与数据面板（P17）：一处可追证的承诺，不是口号。
 *
 * 内容优先读 `GET /api/integration/manifest` 的 `privacy` 段（监听地址 / 数据目录 / network=none /
 * writesSource=false）；后端没提供（旧后端或请求失败）时回落到内置说明，功能不残缺、不报红。
 * 文案对齐 docs/06-platform.md §3.3 的草图。
 */
import { useEffect, useState } from 'react';
import type { PrivacyInfo } from '../../shared/types';
import { api } from './api';
import { Dialog } from './Dialog';
import { useI18n } from './i18n';

export function PrivacyPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [privacy, setPrivacy] = useState<PrivacyInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .privacy()
      .then((info) => {
        if (!cancelled) setPrivacy(info);
      })
      .catch(() => {
        /* 旧后端 / 网络异常：回落内置说明 */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Dialog title={t('privacy.title')} onClose={onClose} wide>
      <p className="wcr-note">{t('privacy.intro')}</p>

      <dl className="privacy-list">
        <div className="privacy-row">
          <dt>{t('privacy.reads')}</dt>
          <dd>{t('privacy.readsBody')}</dd>
        </div>
        <div className="privacy-row">
          <dt>{t('privacy.writes')}</dt>
          <dd>{t('privacy.writesBody')}</dd>
        </div>
        <div className="privacy-row">
          <dt>{t('privacy.sends')}</dt>
          <dd>{t('privacy.sendsBody')}</dd>
        </div>
        <div className="privacy-row">
          <dt>{t('privacy.who')}</dt>
          <dd>{t('privacy.whoBody')}</dd>
        </div>
      </dl>

      <h3 className="wcr-section-title">{t('privacy.proofTitle')}</h3>
      <ul className="privacy-proof">
        <li>{t('privacy.proof1')}</li>
        <li>{t('privacy.proof2')}</li>
        <li>{t('privacy.proof3')}</li>
      </ul>

      {privacy && (
        <ul className="privacy-runtime">
          <li>{t('privacy.runtimeNetwork')}</li>
          <li>{t('privacy.runtimeHost', { host: privacy.host, port: privacy.port })}</li>
          <li>{t('privacy.runtimeDataDir', { dir: privacy.dataDir })}</li>
          <li>{t('privacy.writesSource')}</li>
        </ul>
      )}
      {loaded && !privacy && <p className="wcr-note">{t('privacy.fallbackNote')}</p>}
    </Dialog>
  );
}
