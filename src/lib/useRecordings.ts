import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { CaptureRegion, CapturedNumber, LiveCaptureLog, RecordingMetadata } from '@/lib/types';
import { saveVideoBlob, deleteVideoBlob, getVideoBlob } from '@/lib/indexedDB';

export function useRecordings() {
  const [recordings, setRecordings] = useState<RecordingMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await supabase
      .from('recordings')
      .select('*')
      .order('created_at', { ascending: false });

    if (fetchError) setError(fetchError.message);
    else setRecordings(data as RecordingMetadata[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRecordings();
  }, [fetchRecordings]);

  const saveRecording = useCallback(
    async (
      metadata: Omit<RecordingMetadata, 'id' | 'created_at'>,
      blob: Blob
    ): Promise<RecordingMetadata | null> => {
      const { data, error: insertError } = await supabase
        .from('recordings')
        .insert(metadata)
        .select()
        .maybeSingle();

      if (insertError || !data) {
        setError(insertError?.message ?? 'Failed to save recording metadata');
        return null;
      }

      const saved = data as RecordingMetadata;
      await saveVideoBlob(saved.id, blob);
      setRecordings((prev) => [saved, ...prev]);
      return saved;
    },
    []
  );

  const createCaptureSession = useCallback(async (region: CaptureRegion | null): Promise<string | null> => {
    const { data, error: insertError } = await supabase
      .from('capture_sessions')
      .insert({
        region_x: region ? Math.round(region.x) : null,
        region_y: region ? Math.round(region.y) : null,
        region_width: region ? Math.round(region.width) : null,
        region_height: region ? Math.round(region.height) : null,
        source_width: region ? Math.round(region.sourceWidth) : null,
        source_height: region ? Math.round(region.sourceHeight) : null,
      })
      .select('id')
      .maybeSingle();
    if (insertError || !data) {
      setError(insertError?.message ?? 'Failed to start durable capture session');
      return null;
    }
    return data.id as string;
  }, []);

  const saveCaptureSessionNumber = useCallback(async (sessionId: string, number: CapturedNumber) => {
    const { error: numberError } = await supabase.from('capture_session_numbers').insert({
      session_id: sessionId,
      value: number.value,
      numeric_value: number.numeric_value,
      captured_at: number.captured_at,
      elapsed_ms: number.elapsed_ms,
      confidence: number.confidence,
      source: number.source,
    });
    if (numberError) {
      setError(numberError.message);
      return;
    }
    const { error: heartbeatError } = await supabase
      .from('capture_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (heartbeatError) setError(heartbeatError.message);
  }, []);

  const finishCaptureSession = useCallback(async (sessionId: string, status: 'completed' | 'interrupted') => {
    const { error: finishError } = await supabase
      .from('capture_sessions')
      .update({ status, last_seen_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (finishError) setError(finishError.message);
  }, []);

  const getActiveCaptureLogs = useCallback(async (): Promise<LiveCaptureLog[]> => {
    const { data: sessions, error: sessionError } = await supabase
      .from('capture_sessions')
      .select('id, started_at')
      .eq('status', 'active')
      .order('started_at', { ascending: false });
    if (sessionError || !sessions) {
      if (sessionError) setError(sessionError.message);
      return [];
    }

    const logs = await Promise.all(sessions.map(async (session) => {
      const { data: numbers, error: numberError } = await supabase
        .from('capture_session_numbers')
        .select('*')
        .eq('session_id', session.id)
        .order('elapsed_ms', { ascending: true });
      if (numberError) {
        setError(numberError.message);
        return { sessionId: session.id as string, startedAt: session.started_at as string, events: [] };
      }
      return { sessionId: session.id as string, startedAt: session.started_at as string, events: numbers as CapturedNumber[] };
    }));
    return logs.filter((log) => log.events.length > 0);
  }, []);

  const saveCaptureData = useCallback(
    async (recordingId: string, region: CaptureRegion | null, numbers: CapturedNumber[]) => {
      if (region) {
        const { error: regionError } = await supabase.from('recording_regions').insert({
          recording_id: recordingId,
          x: Math.round(region.x),
          y: Math.round(region.y),
          width: Math.round(region.width),
          height: Math.round(region.height),
          source_width: Math.round(region.sourceWidth),
          source_height: Math.round(region.sourceHeight),
        });
        if (regionError) setError(regionError.message);
      }

      if (numbers.length > 0) {
        const { error: numberError } = await supabase.from('captured_numbers').insert(
          numbers.map((number) => ({ ...number, recording_id: recordingId }))
        );
        if (numberError) setError(numberError.message);
      }
    },
    []
  );

  const getCapturedNumbers = useCallback(async (recordingId: string): Promise<CapturedNumber[]> => {
    const { data, error: fetchError } = await supabase
      .from('captured_numbers')
      .select('*')
      .eq('recording_id', recordingId)
      .order('elapsed_ms', { ascending: true });
    if (fetchError) {
      setError(fetchError.message);
      return [];
    }
    return data as CapturedNumber[];
  }, []);

  const updateRecording = useCallback(
    async (id: string, updates: Partial<Pick<RecordingMetadata, 'title' | 'tags' | 'notes'>>) => {
      const { data, error: updateError } = await supabase
        .from('recordings')
        .update(updates)
        .eq('id', id)
        .select()
        .maybeSingle();
      if (updateError || !data) {
        setError(updateError?.message ?? 'Failed to update recording');
        return null;
      }
      const updated = data as RecordingMetadata;
      setRecordings((prev) => prev.map((r) => (r.id === id ? updated : r)));
      return updated;
    },
    []
  );

  const deleteRecording = useCallback(async (id: string) => {
    const { error: deleteError } = await supabase.from('recordings').delete().eq('id', id);
    if (deleteError) {
      setError(deleteError.message);
      return false;
    }
    await deleteVideoBlob(id);
    setRecordings((prev) => prev.filter((r) => r.id !== id));
    return true;
  }, []);

  const getRecordingVideoUrl = useCallback(async (id: string): Promise<string | null> => {
    const blob = await getVideoBlob(id);
    return blob ? URL.createObjectURL(blob) : null;
  }, []);

  return {
    recordings,
    loading,
    error,
    saveRecording,
    saveCaptureData,
    getCapturedNumbers,
    createCaptureSession,
    saveCaptureSessionNumber,
    finishCaptureSession,
    getActiveCaptureLogs,
    updateRecording,
    deleteRecording,
    getRecordingVideoUrl,
    refresh: fetchRecordings,
  };
}
