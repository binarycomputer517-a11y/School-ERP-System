const PDFDocument = require('pdfkit');

function generateTC(student, res) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    // School Header
    doc.fontSize(24).font('Helvetica-Bold').text('Your School Name', { align: 'center' });
    doc.fontSize(12).text('123 School Address, City, State, PIN', { align: 'center' });
    doc.moveDown(2);

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text('TRANSFER CERTIFICATE', { align: 'center', underline: true });
    doc.moveDown(2);

    // Content
    doc.fontSize(12).font('Helvetica');
    doc.text(`This is to certify that ${student.first_name} ${student.last_name || ''}, son/daughter of Mr. ${student.father_name || 'N/A'} and Mrs. ${student.mother_name || 'N/A'}, was a bonafide student of this institution.`, { lineGap: 8 });
    doc.moveDown();
    doc.text(`Student ID: ${student.id}`, { lineGap: 8 });
    doc.text(`Date of Birth: ${new Date(student.date_of_birth).toLocaleDateString()}`, { lineGap: 8 });
    doc.text(`He/She was studying in Class ${student.class_name} at the time of leaving.`, { lineGap: 8 });
    doc.text(`His/Her character and conduct were satisfactory.`, { lineGap: 8 });
    doc.moveDown();
    doc.text(`We wish him/her all the best for their future endeavors.`, { lineGap: 8 });
    doc.moveDown(4);

    // Footer
    doc.text('__________________', { continued: true });
    doc.text('__________________', { align: 'right' });
    doc.text('Signature of Parent', { continued: true });
    doc.text('Signature of Principal', { align: 'right' });

    doc.end();
}

function generateBonafide(student, res) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.fontSize(24).font('Helvetica-Bold').text('Your School Name', { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(20).font('Helvetica-Bold').text('BONAFIDE CERTIFICATE', { align: 'center', underline: true });
    doc.moveDown(2);

    doc.fontSize(12).font('Helvetica').text(`Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
    doc.moveDown();

    doc.text(`This is to certify that ${student.first_name} ${student.last_name || ''} (Student ID: ${student.id}) is a bonafide student of our school.`, { lineGap: 8 });
    doc.moveDown();
    doc.text(`According to our school records, his/her date of birth is ${new Date(student.date_of_birth).toLocaleDateString()}. He/She is currently studying in Class ${student.class_name}.`, { lineGap: 8 });
    doc.moveDown();
    doc.text('This certificate is issued upon the request of the student for academic purposes.', { lineGap: 8 });
    doc.moveDown(4);

    doc.text('__________________', { align: 'right' });
    doc.moveDown(0.5);
    doc.text('Principal', { align: 'right' });

    doc.end();
}

module.exports = { generateTC, generateBonafide };