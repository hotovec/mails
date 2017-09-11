import gulp from 'gulp';
import plugins from 'gulp-load-plugins';
import browser from 'browser-sync';
import rimraf from 'rimraf';
import panini from 'panini';
import yargs from 'yargs';
import lazypipe from 'lazypipe';
import inky from 'inky';
import fs from 'fs';
import siphon from 'siphon-media-query';
import path from 'path';
import merge from 'merge-stream';
import beep from 'beepbeep';
import colors from 'colors';

const $ = plugins();

// Look for the --production flag
const PRODUCTION = !!(yargs.argv.production);
const EMAIL = yargs.argv.to;
const PROJECT = yargs.argv.project;

var projectName = 'default';
if (PROJECT) {
  projectName = PROJECT;
}


if (projectName === 'default') {
  console.log('\x1b[33m%s\x1b[0m',"\n" + "----------------------");
  console.log('\x1b[33m%s\x1b[0m', "Default project is used!!! Use:\nnpm start -- --project=project_folder_name\nfor project selection");
}
console.log("----------------------------------------------");
console.log("Project used: " + projectName);
console.log("----------------------------------------------" + "\n\n");

const SrcPath = 'projects/' + projectName;
const DstPath = 'dist/' + projectName;


// Declar var so that both AWS and Litmus task can use it.
var CONFIG;

// Build the "dist" folder by running all of the below tasks
gulp.task('build',
  gulp.series(clean, pages, sass, images, inline));

// Build emails, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch));

// Build emails, then send to litmus
gulp.task('litmus',
  gulp.series('build', creds, aws, litmus));

// Build emails, then send to EMAIL
gulp.task('mail',
  gulp.series('build', creds, aws, mail));

// Build emails, then zip
gulp.task('zip',
  gulp.series('build', zip));

// Delete the "dist" folder
// This happens every time a build starts
function clean(done) {
  rimraf(DstPath, done);
}

// Compile layouts, pages, and partials into flat HTML files
// Then parse using Inky templates
function pages() {
  return gulp.src([SrcPath + '/pages/**/*.html', '!' + SrcPath + '/pages/archive/**/*.html'])
    .pipe(panini({
      root: SrcPath + '/pages',
      layouts: SrcPath + '/layouts',
      partials: SrcPath + '/partials',
      helpers: SrcPath + '/helpers'
    }))
    .pipe(inky())
    .pipe(gulp.dest(DstPath));
}

// Reset Panini's cache of layouts and partials
function resetPages(done) {
  panini.refresh();
  done();
}

// Compile Sass into CSS
function sass() {
  return gulp.src(SrcPath + '/assets/scss/app.scss')
    .pipe($.if(!PRODUCTION, $.sourcemaps.init()))
    .pipe($.sass({
      includePaths: ['node_modules/foundation-emails/scss']
    }).on('error', $.sass.logError))
    .pipe($.if(PRODUCTION, $.uncss(
      {
        html: [DstPath + '/**/*.html']
      })))
    .pipe($.if(!PRODUCTION, $.sourcemaps.write()))
    .pipe(gulp.dest(DstPath + '/css'));
}

// Copy and compress images
function images() {
  return gulp.src([SrcPath + 'src/assets/img/**/*', '!' + SrcPath + '/assets/img/archive/**/*'])
    .pipe($.imagemin())
    .pipe(gulp.dest('./' + DstPath + '/assets/img'));
}

// Inline CSS and minify HTML
function inline() {
  return gulp.src(DstPath + '/**/*.html')
    .pipe($.if(PRODUCTION, inliner(DstPath + '/css/app.css')))
    .pipe(gulp.dest(DstPath));
}

// Start a server with LiveReload to preview the site in
function server(done) {
  browser.init({
    server: DstPath
  });
  done();
}

// Watch for file changes
function watch() {
  gulp.watch(SrcPath + '/pages/**/*.html').on('all', gulp.series(pages, inline, browser.reload));
  gulp.watch([SrcPath + '/layouts/**/*', SrcPath + '/partials/**/*']).on('all', gulp.series(resetPages, pages, inline, browser.reload));
  gulp.watch(['../scss/**/*.scss', SrcPath + '/assets/scss/**/*.scss']).on('all', gulp.series(resetPages, sass, pages, inline, browser.reload));
  gulp.watch(SrcPath + '/assets/img/**/*').on('all', gulp.series(images, browser.reload));
}

// Inlines CSS into HTML, adds media query CSS into the <style> tag of the email, and compresses the HTML
function inliner(css) {
  var css = fs.readFileSync(css).toString();
  var mqCss = siphon(css);

  var pipe = lazypipe()
    .pipe($.inlineCss, {
      applyStyleTags: false,
      removeStyleTags: true,
      preserveMediaQueries: true,
      removeLinkTags: false
    })
    .pipe($.replace, '<!-- <style> -->', `<style>${mqCss}</style>`)
    .pipe($.replace, '<link rel="stylesheet" type="text/css" href="css/app.css">', '')
    .pipe($.htmlmin, {
      collapseWhitespace: true,
      minifyCSS: true
    });

  return pipe();
}

// Ensure creds for Litmus are at least there.
function creds(done) {
  var configPath = './config.json';
  try {
    CONFIG = JSON.parse(fs.readFileSync(configPath));
  }
  catch (e) {
    beep();
    console.log('[AWS]'.bold.red + ' Sorry, there was an issue locating your config.json. Please see README.md');
    process.exit();
  }
  done();
}

// Post images to AWS S3 so they are accessible to Litmus and manual test
function aws() {
  var publisher = !!CONFIG.aws ? $.awspublish.create(CONFIG.aws) : $.awspublish.create();
  var headers = {
    'Cache-Control': 'max-age=315360000, no-transform, public'
  };

  return gulp.src('./' + DstPath + '/assets/img/*')
  // publisher will add Content-Length, Content-Type and headers specified above
  // If not specified it will set x-amz-acl to public-read by default
    .pipe(publisher.publish(headers))

    // create a cache file to speed up consecutive uploads
    //.pipe(publisher.cache())

    // print upload updates to console
    .pipe($.awspublish.reporter());
}

// Send email to Litmus for testing. If no AWS creds then do not replace img urls.
function litmus() {
  var awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false;

  return gulp.src(DstPath + '/**/*.html')
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, "=$1" + awsURL)))
    .pipe($.litmus(CONFIG.litmus))
    .pipe(gulp.dest(DstPath));
}

// Send email to specified email for testing. If no AWS creds then do not replace img urls.
function mail() {
  var awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false;

  if (EMAIL) {
    CONFIG.mail.to = [EMAIL];
  }

  return gulp.src(DstPath + '/**/*.html')
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, "=$1" + awsURL)))
    .pipe($.mail(CONFIG.mail))
    .pipe(gulp.dest(DstPath));
}

// Copy and compress into Zip
function zip() {
  var dist = DstPath;
  var ext = '.html';

  function getHtmlFiles(dir) {
    return fs.readdirSync(dir)
      .filter(function (file) {
        var fileExt = path.join(dir, file);
        var isHtml = path.extname(fileExt) == ext;
        return fs.statSync(fileExt).isFile() && isHtml;
      });
  }

  var htmlFiles = getHtmlFiles(dist);

  var moveTasks = htmlFiles.map(function (file) {
    var sourcePath = path.join(dist, file);
    var fileName = path.basename(sourcePath, ext);

    var moveHTML = gulp.src(sourcePath)
      .pipe($.rename(function (path) {
        path.dirname = fileName;
        return path;
      }));

    var moveImages = gulp.src(sourcePath)
      .pipe($.htmlSrc({selector: 'img'}))
      .pipe($.rename(function (path) {
        path.dirname = fileName + path.dirname.replace(DstPath, '');
        return path;
      }));

    return merge(moveHTML, moveImages)
      .pipe($.zip(fileName + '.zip'))
      .pipe(gulp.dest(DstPath));
  });

  return merge(moveTasks);
}
