-- Rename legacy approval event types in session_events to the unified naming.
-- See CHANGELOG entry for the protocol cleanup that drops the tool_ prefix.
UPDATE session_events SET event_type = 'approval_requested' WHERE event_type = 'tool_approval_requested';
UPDATE session_events SET event_type = 'approval_resolved' WHERE event_type = 'tool_approval_resolved';
