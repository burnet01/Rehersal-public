const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const morgan = require('morgan');
const redis = require('redis');
const { MongoClient, ObjectId } = require('mongodb'); // MongoDB import
const archiver = require('archiver');

const app = express();
const port = 3000;

// Setup logging
app.use(morgan('dev'));

// Setup storage for uploaded files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname)); // Append timestamp to filename
    }
});

const upload = multer({ storage: storage });

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Redis Initialization
let redisClient;
const initializeRedis = async () => {
    try {
        redisClient = redis.createClient();
        redisClient.on('error', (err) => console.error('Redis Client Error:', err));
        await redisClient.connect();
        console.log('Connected to Redis server successfully');
    } catch (err) {
        console.error('Error initializing Redis:', err);
    }
};
initializeRedis();

// MongoDB Initialization
let db, imagesCollection;
const initializeMongoDB = async () => {
    try {
        const mongoClient = new MongoClient('mongodb://localhost:27017', { useUnifiedTopology: true });
        await mongoClient.connect();
        db = mongoClient.db('weddingPhotoDB');
        imagesCollection = db.collection('images');
        console.log('Connected to MongoDB successfully');
    } catch (err) {
        console.error('Error initializing MongoDB:', err);
    }
};
initializeMongoDB();

// Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // Serve your HTML file
});

// Upload route
app.post('/upload', upload.array('image', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No files were uploaded.' });
        }

        const filePaths = req.files.map(file => `/uploads/${file.filename}`);
        console.log(`Uploaded Files: ${filePaths}`);

        // Save file metadata to MongoDB
        const fileData = await Promise.all(req.files.map(async (file) => {
            const stats = fs.stat(file.path); // Get file system metadata
            return {
                fileName: file.filename,
                uploadTime: new Date(),
                fileCreationTime: stats.birthtime,  // Store the file creation time (birthtime)
                filePath: `/uploads/${file.filename}`,
            };
        }));

        // Insert files into MongoDB, log the result
        const mongoResult = await imagesCollection.insertMany(fileData);
        console.log('MongoDB Insert Result:', mongoResult.insertedCount);

        if (mongoResult.insertedCount !== fileData.length) {
            console.error('Some files failed to insert into MongoDB');
            return res.status(500).json({ message: 'Failed to insert some files into MongoDB' });
        }

        console.log('Files successfully inserted into MongoDB:', mongoResult.insertedIds);

        // Push file paths to Redis (one by one)
        for (let filePath of filePaths) {
            await redisClient.rPush('uploadedFiles', filePath);
            console.log(`File path added to Redis: ${filePath}`);
        }

        // Fetch all images after upload
        const existingImages = await fetchAllImages();
        res.json({ message: 'Files uploaded successfully!', files: filePaths, allImages: existingImages });

    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({ message: 'Error during upload', error: err });
    }
});

// Fetch all images from the file system and clean Redis cache
const fetchAllImages = async () => {
    try {
        const redisFiles = await redisClient.lRange('uploadedFiles', 0, -1); // All Redis entries
        const filesInStorage = await fs.readdir(path.join(__dirname, 'uploads')); // All actual files in /uploads
        const supportedImageFormats = /\.(jpg|jpeg|png|gif|jfif|webp)$/i;
        const validFiles = filesInStorage
            .filter(file => supportedImageFormats.test(file))
            .map(file => path.join('/uploads', file));

        // Clean Redis: Remove entries not existing in the filesystem
        const invalidFilesInRedis = redisFiles.filter(file => !validFiles.includes(file));
        if (invalidFilesInRedis.length > 0) {
            for (const file of invalidFilesInRedis) {
                await redisClient.lRem('uploadedFiles', 0, file);
                console.log(`Removed ghost file from Redis: ${file}`);
            }
        }

        return validFiles;
    } catch (err) {
        console.error('Error cleaning Redis:', err);
        throw err;
    }
};

// Route to delete files
app.delete('/delete/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const fileDoc = await imagesCollection.findOne({ _id: ObjectId(id) });

        if (!fileDoc) {
            return res.status(404).json({ message: 'File not found in MongoDB' });
        }

        const filePath = path.join(__dirname, fileDoc.filePath);

        // Remove file from file system
        await fs.unlink(filePath);
        console.log(`File ${fileDoc.fileName} removed from file system`);

        // Remove file metadata from MongoDB
        await imagesCollection.deleteOne({ _id: ObjectId(id) });
        console.log(`File ${fileDoc.fileName} removed from MongoDB`);

        // Remove file path from Redis
        await redisClient.lRem('uploadedFiles', 0, fileDoc.filePath);
        console.log(`File path ${fileDoc.filePath} removed from Redis`);

        res.json({ message: 'File deleted successfully!' });

    } catch (err) {
        console.error('Error during file deletion:', err);
        res.status(500).json({ message: 'Error deleting file', error: err });
    }
});

// Images route
app.get('/images', async (req, res) => {
    try {
        const validImages = await fetchAllImages();
        console.log('Existing Images:', validImages);
        res.json(validImages);

    } catch (err) {
        res.status(500).json({ message: 'Error reading uploads directory', error: err });
    }
});

// Route to download all images as a ZIP file
app.get('/download-all', async (req, res) => {
    try {
        const validImages = await fetchAllImages(); // Get all valid images
        if (validImages.length === 0) {
            return res.status(404).json({ message: 'No images to download' });
        }

        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('all-images.zip');

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(res); // Stream the archive to the client

        validImages.forEach((file) => {
            const filePath = path.join(__dirname, file);
            archive.file(filePath, { name: path.basename(file) });
        });

        archive.finalize(); // Complete the archive
    } catch (err) {
        console.error('Error during download:', err);
        res.status(500).json({ message: 'Error during download', error: err });
    }
});

// Constant status logging and cleanup every minute
setInterval(async () => {
    try {
        await fetchAllImages();
        const files = await fs.readdir(path.join(__dirname, 'uploads'));
        console.log(`Current Uploads: ${files.length} files in the uploads folder.`);
    } catch (err) {
        console.error('Error during status logging:', err);
    }
}, 60000); // Every 60 seconds

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
