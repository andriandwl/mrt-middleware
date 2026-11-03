import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../api';

/**
 * Ambil data dari REST API. `params` diserialisasi agar efek hanya berjalan saat filter berubah.
 * `refreshMs` (opsional) untuk polling berkala.
 */
export function useApi(path, params = {}, { refreshMs, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const key = JSON.stringify(params);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const d = await apiGet(path, JSON.parse(key));
      setData(d);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [path, key, enabled]);

  useEffect(() => {
    setLoading(enabled);
    load();
    if (!refreshMs || !enabled) return undefined;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs, enabled]);

  return { data, setData, error, loading, reload: load };
}
