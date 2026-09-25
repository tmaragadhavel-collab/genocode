import { Router } from 'express';
import { dbService } from '../services/dbService';
import { isDBConnected } from '../db';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const interviews = await dbService.listInterviews();
    res.json({ interviews, persistence: isDBConnected() ? 'mongodb' : 'memory' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch interviews' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const interview = await dbService.getInterview(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    res.json(interview);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch interview' });
  }
});

router.get('/:id/transcript', async (req, res) => {
  try {
    const transcripts = await dbService.getTranscripts(req.params.id);
    res.json({ transcripts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transcripts' });
  }
});

router.get('/:id/insights', async (req, res) => {
  try {
    const insights = await dbService.getAIInsights(req.params.id);
    res.json({ insights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const interview = await dbService.getInterview(req.params.id);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });
    const transcripts = await dbService.getTranscripts(req.params.id);
    const insights = await dbService.getAIInsights(req.params.id);
    res.json({ interview, transcripts, insights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
