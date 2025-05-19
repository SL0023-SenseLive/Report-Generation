const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const moment = require('moment');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create a directory for temporary files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Database connection
// const pool = new Pool({
//   user: 'tb_user',
//   host: 'platform.senselive.io',
//   database: 'thingsboard',
//   password: 'StrongPass123!',
//   port: 5432
// });


const pool = new Pool({
  user: process.env.DB_USER ,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});


// Test database connection
pool.connect()
  .then(client => {
    console.log('✅ Connected to PostgreSQL database successfully.');
    client.release();
  })
  .catch(err => {
    console.error('❌ Failed to connect to PostgreSQL database:', err);
    process.exit(1); // Exit the app if DB connection fails
  });

// Simple test endpoint
app.get('/test-connection', (req, res) => {
  console.log('Test connection endpoint hit');
  res.json({ message: 'Server is reachable' });
});

// API endpoint to fetch devices
app.get('/api/devices', async (req, res) => {
  try {
    // Query to fetch devices from ThingsBoard database
    const query = `
      SELECT id, name FROM public.device;
    `;

    const result = await pool.query(query);

    // Format the response
    const devices = result.rows.map(row => ({
      id: row.id,
      name: row.name
    }));

    res.json(devices);
   
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// API endpoint to get energy data for reports or preview
app.get('/api/energy-data', async (req, res) => {
  try {
    const { deviceId, startDate, endDate, timePeriod } = req.query;

    console.log('Received request with params:', req.query);
    // Validate inputs (basic)
    if (!deviceId || !startDate || !endDate || !timePeriod) {
      return res.status(400).json({ error: 'Missing required query params.' });
    }
    if (!['daily', 'weekly', 'monthly'].includes(timePeriod)) {
      return res.status(400).json({ error: 'Invalid timePeriod value.' });
    }

    const query = `
      WITH keys AS (
        SELECT key_id, key
        FROM public.key_dictionary
        WHERE key IN (
          'KVAH_Total', 'KWH_Import', 'KVARH_Import',
          'delta_kWh', 'delta_kVAh', 'delta_kVArh'
        )
      ),
      kv_filtered AS (
        SELECT 
          to_timestamp(ts_kv.ts / 1000.0) AS ts,
          kd.key,
          NULLIF(COALESCE(ts_kv.dbl_v::text, ts_kv.long_v::text, ts_kv.str_v), '')::numeric AS value
        FROM public.ts_kv ts_kv
        JOIN keys kd ON kd.key_id = ts_kv.key
        WHERE ts_kv.entity_id = $1
          AND to_timestamp(ts_kv.ts / 1000.0) BETWEEN $2 AND $3
      ),
      kv_period AS (
        SELECT 
          ts,
          key,
          value,
          CASE 
            WHEN $4 = 'daily' THEN date_trunc('day', ts)
            WHEN $4 = 'weekly' THEN date_trunc('week', ts)
            WHEN $4 = 'monthly' THEN date_trunc('month', ts)
          END AS period
        FROM kv_filtered
      ),
      -- Latest values for Import keys
      latest_values AS (
        SELECT DISTINCT ON (period, key)
          period,
          key,
          value
        FROM kv_period
        WHERE key IN ('KVAH_Total', 'KWH_Import', 'KVARH_Import')
        ORDER BY period, key, ts DESC
      ),
      -- Pivoted latest values
      pivoted_latest AS (
        SELECT
          period,
          MAX(CASE WHEN key = 'KVAH_Total' THEN value END) AS "KVAH_Total",
          MAX(CASE WHEN key = 'KWH_Import' THEN value END) AS "KWH_Import",
          MAX(CASE WHEN key = 'KVARH_Import' THEN value END) AS "KVARH_Import"
        FROM latest_values
        GROUP BY period
      ),
      -- Aggregated deltas
      delta_sums AS (
        SELECT
          period,
          SUM(CASE WHEN key = 'delta_kWh' THEN value ELSE 0 END) AS "delta_kWh",
          SUM(CASE WHEN key = 'delta_kVAh' THEN value ELSE 0 END) AS "delta_kVAh",
          SUM(CASE WHEN key = 'delta_kVArh' THEN value ELSE 0 END) AS "delta_kVArh"
        FROM kv_period
        WHERE key IN ('delta_kWh', 'delta_kVAh', 'delta_kVArh')
        GROUP BY period
      )
      -- Final combined result
      SELECT 
        ds.period,
        pl."KVAH_Total",
        pl."KWH_Import",
        pl."KVARH_Import",
        ds."delta_kWh",
        ds."delta_kVAh",
        ds."delta_kVArh"
      FROM delta_sums ds
      LEFT JOIN pivoted_latest pl ON ds.period = pl.period
      ORDER BY ds.period;
    `;

    const values = [deviceId, startDate, endDate, timePeriod];
    const { rows } = await pool.query(query, values);

    // Process data for better formatting
    const formattedData = rows.map(row => ({
      period: moment(row.period).format('YYYY-MM-DD'),
      KVAH_Total: parseFloat(row.KVAH_Total || 0).toFixed(2),
      KWH_Import: parseFloat(row.KWH_Import || 0).toFixed(2),
      KVARH_Import: parseFloat(row.KVARH_Import || 0).toFixed(2),
      delta_kWh: parseFloat(row.delta_kWh || 0).toFixed(2),
      delta_kVAh: parseFloat(row.delta_kVAh || 0).toFixed(2),
      delta_kVArh: parseFloat(row.delta_kVArh || 0).toFixed(2)
    }));

    console.log('Query executed successfully:', formattedData);
    res.json(formattedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API endpoint to get report preview (formatted HTML)
app.post('/api/reports/preview', async (req, res) => {
  try {
    const { reportType, timePeriod, startDate, endDate, deviceId } = req.body;

    if (!reportType || !timePeriod || !startDate || !endDate || !deviceId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Currently only supporting energy_consumption
    if (reportType !== 'energy_consumption') {
      return res.status(400).json({ error: 'Only energy_consumption reports are supported for preview' });
    }

    // Get the energy data using the existing endpoint
    const response = await fetch(`http://localhost:8080/api/energy-data?deviceId=${deviceId}&startDate=${startDate}&endDate=${endDate}&timePeriod=${timePeriod}`);
    const data = await response.json();

    // Calculate summary statistics
    const totalEnergyConsumption = data.reduce((sum, item) => sum + parseFloat(item.delta_kWh), 0).toFixed(2);
   
    // Format date for display
    const formattedStartDate = moment(startDate).format('MMMM D, YYYY');
    const formattedEndDate = moment(endDate).format('MMMM D, YYYY');
    
    // Get device name (optional)
    let deviceName = "Unknown Device";
    try {
      const deviceResponse = await pool.query('SELECT name FROM public.device WHERE id = $1', [deviceId]);
      if (deviceResponse.rows.length > 0) {
        deviceName = deviceResponse.rows[0].name;
      }
    } catch (error) {
      console.error('Error getting device name:', error);
    }

    // Build HTML for the report
    let html = `
      <div class="report-header">
        <h2>Energy Consumption Report</h2>
        <div class="report-info">Device: ${deviceName} (ID: ${deviceId})</div>
        <div class="report-info">Period: ${formattedStartDate} to ${formattedEndDate}</div>
        <div class="report-info">Report Type: ${timePeriod.charAt(0).toUpperCase() + timePeriod.slice(1)}</div>
      </div>

      

      <div class="report-section">
        <h3>Detailed Data</h3>
        <table class="report-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>KWH_Import</th>
              <th>KVAH_Total</th>
              <th>KVARH_Import</th>
              <th>delta_kWh</th>
              <th>delta_kVAh</th>
              <th>delta_kVArh</th>
            </tr>
          </thead>
          <tbody>
    `;

    // Add rows to the table 'delta_kWh', 'delta_kVAh', 'delta_kVArh', 'KWH_Import', 'KVAH_Total', 'KVARH_Import'
    data.forEach(item => {
      html += `
        <tr>
          <td>${item.period}</td>
           <td>${item.KWH_Import}</td>
          <td>${item.KVAH_Total}</td>
          <td>${item.KVARH_Import}</td>
          <td>${item.delta_kWh}</td>
          <td>${item.delta_kVAh}</td>
          <td>${item.delta_kVArh}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    res.json({ html });
  } catch (error) {
    console.error('Error generating preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Generate PDF report
function generatePdfReport(data, reportType, deviceId, deviceName, startDate, endDate, timePeriod) {
  return new Promise((resolve, reject) => {
    try {
      const filename = `${reportType}_${deviceId}_${startDate}_to_${endDate}.pdf`;
      const filePath = path.join(TEMP_DIR, filename);

      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);

      doc.pipe(stream);

      
      // Format dates
      const formattedStartDate = moment(startDate).format('MMMM D, YYYY');
      const formattedEndDate = moment(endDate).format('MMMM D, YYYY');

      // Add report header
      doc.fontSize(22).fillColor('#3f51b5').text('ENERGY CONSUMPTION REPORT', {
        align: 'center'
      });

      doc.moveDown();
      doc.fontSize(12).fillColor('#000')
         .text(`Device: ${deviceName} (ID: ${deviceId})`);
      doc.fontSize(12).text(`Period: ${formattedStartDate} to ${formattedEndDate}`);
      doc.fontSize(12).text(`Report Type: ${timePeriod.charAt(0).toUpperCase() + timePeriod.slice(1)}`);
      doc.moveDown();

      

      // Add detailed table
      doc.fontSize(16).fillColor('#3f51b5').text('Detailed Data', { underline: true });
      doc.moveDown();

      // Create a simple table
      const tableData = data.map(item => [
        item.period,
        item.KWH_Import,
        item.KVAH_Total,  
        item.KVARH_Import,
        item.delta_kWh,
        item.delta_kVAh,  
        item.delta_kVArh
      ]);

      //'period', 'delta_kWh', 'delta_kVAh', 'delta_kVArh', 'KWH_Import', 'KVAH_Total', 'KVARH_Import'
      
      // Add table headers
      const tableHeaders = ['period','KWH_Import', 'KVAH_Total', 'KVARH_Import', 'delta_kWh', 'delta_kVAh', 'delta_kVArh', ];
      const tableTop = doc.y;
      const tableLeft = 50;
      const colWidth = (doc.page.width - 100) / tableHeaders.length;
      
      // Draw header
      tableHeaders.forEach((header, i) => {
        doc.fontSize(10).fillColor('#3f51b5')
           .text(header, tableLeft + (i * colWidth), tableTop, { width: colWidth, align: 'left' });
      });
      
      // Draw rows
      let rowTop = tableTop + 20;
      doc.fillColor('#000');
      
      tableData.forEach((row, rowIndex) => {
        // Add a new page if needed
        if (rowTop > doc.page.height - 100) {
          doc.addPage();
          rowTop = 50;
        }
        
        row.forEach((cell, i) => {
          doc.fontSize(9)
             .text(cell, tableLeft + (i * colWidth), rowTop, { width: colWidth, align: 'left' });
        });
        
        rowTop += 20;
        
        // Add light gray background for even rows
        if (rowIndex % 2 === 1) {
          doc.rect(tableLeft, rowTop - 20, doc.page.width - 100, 20).fillColor('#f5f7ff').fill();
          doc.fillColor('#000'); // Reset to black for text
        }
      });

      // Add footer
      doc.fontSize(8).text(`Report generated on: ${moment().format('MMMM D, YYYY')}`, {
        align: 'right'
      });

      doc.end();

      stream.on('finish', () => {
        resolve(filePath);
      });

      stream.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Generate CSV from data
function generateCsvString(data) {
  try {
    const fields = ['period','KWH_Import', 'KVAH_Total', 'KVARH_Import', 'delta_kWh', 'delta_kVAh', 'delta_kVArh', ];
    const json2csvParser = new Parser({ fields });
    return json2csvParser.parse(data);
  } catch (error) {
    console.error('Error generating CSV:', error);
    throw error;
  }
}

// API endpoint to generate PDF report
app.post('/api/reports/generate-pdf', async (req, res) => {
  try {
    const { reportType, timePeriod, startDate, endDate, deviceId } = req.body;

    if (!reportType || !timePeriod || !startDate || !endDate || !deviceId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Currently only supporting energy_consumption
    if (reportType !== 'energy_consumption') {
      return res.status(400).json({ error: 'Only energy_consumption reports are supported' });
    }

    // Get device name
    let deviceName = "Unknown Device";
    try {
      const deviceResponse = await pool.query('SELECT name FROM public.device WHERE id = $1', [deviceId]);
      if (deviceResponse.rows.length > 0) {
        deviceName = deviceResponse.rows[0].name;
      }
    } catch (error) {
      console.error('Error getting device name:', error);
    }

    // Get the energy data using the existing endpoint
    const apiUrl = `http://localhost:8080/api/energy-data?deviceId=${deviceId}&startDate=${startDate}&endDate=${endDate}&timePeriod=${timePeriod}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    // Generate PDF
    const pdfPath = await generatePdfReport(data, reportType, deviceId, deviceName, startDate, endDate, timePeriod);

    // Send the file
    res.download(pdfPath, path.basename(pdfPath), (err) => {
      if (err) {
        console.error('Error sending file:', err);
      }

      // Delete the file after sending
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) {
          console.error('Error deleting file:', unlinkErr);
        }
      });
    });
  } catch (error) {
    console.error('Error generating PDF report:', error);
    res.status(500).json({ error: 'Failed to generate PDF report' });
  }
});

// API endpoint to generate CSV report
app.post('/api/reports/generate-csv', async (req, res) => {
  try {
    const { reportType, timePeriod, startDate, endDate, deviceId } = req.body;

    if (!reportType || !timePeriod || !startDate || !endDate || !deviceId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Currently only supporting energy_consumption
    if (reportType !== 'energy_consumption') {
      return res.status(400).json({ error: 'Only energy_consumption reports are supported' });
    }

    // Get the energy data using the existing endpoint
    const apiUrl = `http://localhost:8080/api/energy-data?deviceId=${deviceId}&startDate=${startDate}&endDate=${endDate}&timePeriod=${timePeriod}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    // Generate CSV string
    const csvString = generateCsvString(data);

    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 
      `attachment; filename=${reportType}_${deviceId}_${startDate}_to_${endDate}.csv`);

    // Send the CSV data
    res.send(csvString);
  } catch (error) {
    console.error('Error generating CSV report:', error);
    res.status(500).json({ error: 'Failed to generate CSV report' });
  }
});

// Clean up temporary files periodically
setInterval(() => {
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) {
      console.error('Error reading temp directory:', err);
      return;
    }

    const now = new Date();

    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);

      fs.stat(filePath, (statErr, stats) => {
        if (statErr) {
          console.error(`Error getting stats for file ${file}:`, statErr);
          return;
        }

        // Delete files older than 1 hour
        const fileAge = (now - stats.mtime) / 1000 / 60; // in minutes
        if (fileAge > 60) {
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) {
              console.error(`Error deleting file ${file}:`, unlinkErr);
            }
          });
        }
      });
    });
  });
}, 30 * 60 * 1000); // Run every 30 minutes


app.use(express.static(path.join(__dirname, 'public')));

// Route for /report
app.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Report server running on http://localhost:${PORT}`);
});