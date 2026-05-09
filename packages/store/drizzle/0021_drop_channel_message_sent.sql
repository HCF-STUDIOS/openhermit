-- Convert legacy `channel_message_sent` rows into normal assistant messages
-- with delivery details folded into payload.metadata. This unifies the
-- conversation-log shape so the LLM history replay path treats proactive
-- sends just like ordinary assistant turns.

UPDATE session_events
SET event_type = 'assistant',
    content = payload->>'text',
    payload = (payload - 'type' - 'text' - 'fromSession' - 'channel' - 'to' - 'messageId')
              || jsonb_build_object(
                'content', payload->>'text',
                'metadata', jsonb_strip_nulls(jsonb_build_object(
                  'source', 'session_send',
                  'fromSession', payload->>'fromSession',
                  'channel', payload->>'channel',
                  'to', payload->>'to',
                  'messageId', payload->>'messageId'
                ))
              )
WHERE event_type = 'channel_message_sent';
