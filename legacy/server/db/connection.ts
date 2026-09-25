import mongoose from 'mongoose';

let connected = false;

export async function connectDB(uri: string | null): Promise<boolean> {
  if (!uri) {
    console.log('[db] No MONGODB_URI — using in-memory storage (Demo Mode)');
    return false;
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    console.log('[db] Connected to MongoDB');
    return true;
  } catch (err) {
    console.log('[db] MongoDB connection failed — falling back to in-memory storage');
    console.log('[db]', (err as Error).message);
    return false;
  }
}

export function isDBConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}
