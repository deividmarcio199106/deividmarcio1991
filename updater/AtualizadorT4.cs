// ATUALIZADOR T4 — deploy 1-clique para a VPS.
//
// Compila com o csc.exe que já vem no Windows (.NET Framework 4). Sem SDK,
// sem instalar nada: `updater\build.cmd` produz `Atualizar-T4.exe`.
//
// Garantias do fluxo (nesta ordem, e nenhuma pode ser pulada):
//   1. empacota SEM node_modules, .git, .env, data e .output;
//   2. envia para releases/<timestamp> — nunca por cima da versão no ar;
//   3. instala e builda NA VPS, dentro do release novo;
//   4. só troca o symlink `current` DEPOIS do build passar;
//   5. recarrega o PM2 e faz healthcheck real;
//   6. qualquer falha em 3–5 devolve o symlink para o release anterior.
//
// A versão que está no ar continua servindo durante todo o processo.
//
// Segurança: autentica só por chave SSH. Não guarda, não pede e não transporta
// senha. Não embute chave de API. Valida o host antes de qualquer envio.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AtualizadorT4
{
    public class Config
    {
        public string Host = "";
        public string User = "";
        public int Port = 22;
        public string IdentityFile = "";
        public string RemotePath = "/var/www/analisador";
        public string Pm2App = "analisador";
        public string HealthUrl = "";
        public string LocalProjectPath = "";
        public string NodeInstall = "npm ci";
        public string BuildCommand = "npm run build";
        public int KeepReleases = 5;

        static string Str(string json, string key, string fallback)
        {
            var match = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"",
                RegexOptions.IgnoreCase);
            if (!match.Success) return fallback;
            return match.Groups[1].Value.Replace("\\\\", "\\").Replace("\\\"", "\"");
        }

        static int Int(string json, string key, int fallback)
        {
            var match = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(\\d+)", RegexOptions.IgnoreCase);
            int value;
            if (match.Success && int.TryParse(match.Groups[1].Value, out value)) return value;
            return fallback;
        }

        // O arquivo é um objeto plano de strings e números; um leitor mínimo
        // evita depender de System.Text.Json, ausente no .NET Framework 4.
        public static Config Load(string path)
        {
            var config = new Config();
            if (!File.Exists(path)) return config;
            var json = File.ReadAllText(path, Encoding.UTF8);
            config.Host = Str(json, "host", "");
            config.User = Str(json, "user", "");
            config.Port = Int(json, "port", 22);
            config.IdentityFile = Str(json, "identityFile", "");
            config.RemotePath = Str(json, "remotePath", "/var/www/analisador");
            config.Pm2App = Str(json, "pm2App", "analisador");
            config.HealthUrl = Str(json, "healthUrl", "");
            config.LocalProjectPath = Str(json, "localProjectPath", "");
            config.NodeInstall = Str(json, "nodeInstall", "npm ci");
            config.BuildCommand = Str(json, "buildCommand", "npm run build");
            config.KeepReleases = Int(json, "keepReleases", 5);
            return config;
        }

        public List<string> Validate()
        {
            var problems = new List<string>();
            if (string.IsNullOrWhiteSpace(Host)) problems.Add("host não configurado");
            if (string.IsNullOrWhiteSpace(User)) problems.Add("user não configurado");
            if (Port <= 0 || Port > 65535) problems.Add("port inválido");
            if (string.IsNullOrWhiteSpace(RemotePath) || !RemotePath.StartsWith("/"))
                problems.Add("remotePath precisa ser um caminho absoluto no servidor");
            if (string.IsNullOrWhiteSpace(Pm2App)) problems.Add("pm2App não configurado");
            if (string.IsNullOrWhiteSpace(HealthUrl)) problems.Add("healthUrl não configurado");
            if (!string.IsNullOrWhiteSpace(IdentityFile) && !File.Exists(IdentityFile))
                problems.Add("identityFile não encontrado: " + IdentityFile);
            return problems;
        }
    }

    public class Runner
    {
        readonly Action<string> log;
        public Runner(Action<string> log) { this.log = log; }

        public int Run(string exe, string args, string workingDir, out string stdout, int timeoutMs)
        {
            log("$ " + exe + " " + Sanitize(args));
            var info = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            if (!string.IsNullOrEmpty(workingDir)) info.WorkingDirectory = workingDir;

            var output = new StringBuilder();
            using (var process = new Process())
            {
                process.StartInfo = info;
                process.OutputDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    lock (output) output.AppendLine(e.Data);
                    log("  " + e.Data);
                };
                process.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    lock (output) output.AppendLine(e.Data);
                    log("  " + e.Data);
                };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    lock (output) output.AppendLine("TIMEOUT");
                    log("  !! timeout após " + (timeoutMs / 1000) + "s");
                    stdout = output.ToString();
                    return -1;
                }
                // WaitForExit sem timeout depois de sair drena os buffers pendentes.
                process.WaitForExit();
                lock (output) stdout = output.ToString();
                return process.ExitCode;
            }
        }

        // Nada sensível vai para o log — o updater não transporta senha, mas se
        // alguém colar uma no comando, ela não é registrada.
        static string Sanitize(string args)
        {
            return Regex.Replace(args, @"(password|senha|token|secret)=\S+", "$1=***",
                RegexOptions.IgnoreCase);
        }
    }

    public class Deployer
    {
        readonly Config config;
        readonly Runner runner;
        readonly Action<string> log;
        readonly Action<string, string> step;

        public Deployer(Config config, Action<string> log, Action<string, string> step)
        {
            this.config = config;
            this.log = log;
            this.step = step;
            this.runner = new Runner(log);
        }

        string SshBase()
        {
            var parts = new List<string>
            {
                "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "ConnectTimeout=10",
                "-p", config.Port.ToString(CultureInfo.InvariantCulture),
            };
            if (!string.IsNullOrWhiteSpace(config.IdentityFile))
            {
                parts.Add("-i");
                parts.Add("\"" + config.IdentityFile + "\"");
            }
            return string.Join(" ", parts);
        }

        string Target { get { return config.User + "@" + config.Host; } }

        public bool Ssh(string remoteCommand, int timeoutMs, out string output)
        {
            var escaped = remoteCommand.Replace("\"", "\\\"");
            var args = SshBase() + " " + Target + " \"" + escaped + "\"";
            return runner.Run("ssh", args, null, out output, timeoutMs) == 0;
        }

        public bool TestConnection(out string output)
        {
            step("Conexão", "testando");
            var ok = Ssh("echo T4_OK && uname -a && (node -v || true) && (pm2 -v || true)", 30000, out output);
            step("Conexão", ok ? "CONECTADO" : "FALHOU");
            return ok && output.Contains("T4_OK");
        }

        /// Empacota o projeto excluindo tudo que não pode ir para a VPS.
        public bool Package(string projectPath, string archivePath, out string output)
        {
            step("Preparando", "empacotando");
            var excludes = new[]
            {
                "node_modules", ".git", ".output", ".nitro", "dist", "data",
                ".env", ".env.local", ".env.production", "*.sqlite", "*.sqlite-wal",
                "*.sqlite-shm", ".DS_Store", "updater",
            };
            var sb = new StringBuilder();
            foreach (var exclude in excludes) sb.Append("--exclude=\"" + exclude + "\" ");
            // O tar.exe do Windows 10+ é o bsdtar; -a infere gzip pela extensão.
            var args = "-a -c -f \"" + archivePath + "\" " + sb + " .";
            var code = runner.Run("tar", args, projectPath, out output, 300000);
            var ok = code == 0 && File.Exists(archivePath);
            step("Preparando", ok ? "OK" : "FALHOU");
            return ok;
        }

        public bool Upload(string archivePath, string remoteTmp, out string output)
        {
            step("Enviando", "scp");
            var identity = string.IsNullOrWhiteSpace(config.IdentityFile)
                ? ""
                : " -i \"" + config.IdentityFile + "\"";
            var args = "-o BatchMode=yes -o StrictHostKeyChecking=accept-new -P "
                + config.Port.ToString(CultureInfo.InvariantCulture) + identity
                + " \"" + archivePath + "\" " + Target + ":" + remoteTmp;
            var ok = runner.Run("scp", args, null, out output, 900000) == 0;
            step("Enviando", ok ? "OK" : "FALHOU");
            return ok;
        }

        /// Script remoto: extrai, instala, builda. NÃO troca o `current`.
        public bool BuildRelease(string release, string remoteTmp, out string output)
        {
            step("Build", "instalando e compilando na VPS");
            var root = config.RemotePath;
            var script = string.Join(" && ", new[]
            {
                "set -e",
                "mkdir -p " + root + "/releases/" + release,
                "mkdir -p " + root + "/shared",
                "tar -xzf " + remoteTmp + " -C " + root + "/releases/" + release,
                "rm -f " + remoteTmp,
                // .env e data vivem em shared/ e são LIGADOS, nunca copiados nem
                // sobrescritos: é o que impede o deploy de apagar configuração
                // e banco de produção.
                "if [ -f " + root + "/shared/.env ]; then ln -sfn " + root + "/shared/.env "
                    + root + "/releases/" + release + "/.env; fi",
                "mkdir -p " + root + "/shared/data",
                "ln -sfn " + root + "/shared/data " + root + "/releases/" + release + "/data",
                "cd " + root + "/releases/" + release,
                config.NodeInstall,
                config.BuildCommand,
            });
            var ok = Ssh(script, 1800000, out output);
            step("Build", ok ? "PASS" : "FAIL");
            return ok;
        }

        /// Troca atômica do symlink + reload do PM2. Devolve o release anterior.
        public bool Promote(string release, out string previous, out string output)
        {
            step("PM2", "promovendo release");
            var root = config.RemotePath;
            string readPrevious;
            previous = "";
            if (Ssh("readlink -f " + root + "/current 2>/dev/null || echo NONE", 30000, out readPrevious))
            {
                var line = readPrevious.Split('\n').Select(l => l.Trim())
                    .LastOrDefault(l => l.Length > 0 && !l.StartsWith("$"));
                if (!string.IsNullOrEmpty(line) && line != "NONE") previous = line;
            }

            var script = string.Join(" && ", new[]
            {
                "set -e",
                // ln -sfnT sobre um diretório temporário + mv é a troca atômica:
                // nunca existe um instante sem `current`.
                "ln -sfn " + root + "/releases/" + release + " " + root + "/current.new",
                "mv -Tf " + root + "/current.new " + root + "/current",
                "cd " + root + "/current",
                "(pm2 reload " + config.Pm2App + " --update-env || pm2 start npm --name "
                    + config.Pm2App + " -- start)",
                "pm2 save || true",
            });
            var ok = Ssh(script, 300000, out output);
            step("PM2", ok ? "OK" : "FALHOU");
            return ok;
        }

        public bool HealthCheck(out string output)
        {
            step("Health Check", "verificando");
            // Espera o processo subir antes de julgar; 3 tentativas espaçadas.
            var script = "for i in 1 2 3 4 5 6; do "
                + "code=$(curl -s -o /tmp/t4health.json -w '%{http_code}' --max-time 10 '"
                + config.HealthUrl + "' || echo 000); "
                + "if [ \"$code\" = \"200\" ]; then echo HEALTH_OK; cat /tmp/t4health.json; exit 0; fi; "
                + "echo tentativa $i codigo $code; sleep 5; done; echo HEALTH_FAIL; exit 1";
            var ok = Ssh(script, 120000, out output) && output.Contains("HEALTH_OK");
            step("Health Check", ok ? "PASS" : "FAIL");
            return ok;
        }

        public bool Rollback(string previous, out string output)
        {
            output = "";
            if (string.IsNullOrEmpty(previous))
            {
                log("!! Não havia release anterior: nada para restaurar.");
                return false;
            }
            step("Rollback", "restaurando versão anterior");
            var root = config.RemotePath;
            var script = string.Join(" && ", new[]
            {
                "ln -sfn " + previous + " " + root + "/current.new",
                "mv -Tf " + root + "/current.new " + root + "/current",
                "cd " + root + "/current",
                "(pm2 reload " + config.Pm2App + " --update-env || true)",
            });
            var ok = Ssh(script, 300000, out output);
            step("Rollback", ok ? "RESTAURADO" : "FALHOU");
            return ok;
        }

        public bool Prune(out string output)
        {
            var root = config.RemotePath;
            var keep = Math.Max(2, config.KeepReleases);
            var script = "cd " + root + "/releases && ls -1t | tail -n +" + (keep + 1)
                + " | xargs -r rm -rf";
            return Ssh(script, 120000, out output);
        }
    }

    public class MainForm : Form
    {
        readonly Config config;
        readonly string configPath;
        readonly string logPath;
        readonly object logLock = new object();

        TextBox projectBox;
        Label serverLabel;
        Button updateButton, logButton, rollbackButton, testButton;
        ListBox stepsBox;
        TextBox logBox;
        readonly Dictionary<string, int> stepIndex = new Dictionary<string, int>();
        readonly string[] stepNames = {
            "Conexão", "Preparando", "Backup", "Enviando", "Build", "PM2", "Health Check", "Concluído",
        };
        volatile bool running;

        public MainForm(Config config, string configPath, string droppedPath)
        {
            this.config = config;
            this.configPath = configPath;
            this.logPath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".",
                "atualizador-t4.log");

            Text = "ATUALIZADOR T4";
            Width = 860;
            Height = 620;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(18, 20, 24);
            ForeColor = Color.Gainsboro;
            Font = new Font("Segoe UI", 9f);
            AllowDrop = true;
            DragEnter += OnDragEnter;
            DragDrop += OnDragDrop;

            BuildUi();

            var initial = !string.IsNullOrWhiteSpace(droppedPath)
                ? droppedPath
                : config.LocalProjectPath;
            projectBox.Text = initial ?? "";

            Log("Atualizador T4 iniciado.");
            Log("Configuração: " + configPath);
            var problems = config.Validate();
            if (problems.Count > 0)
            {
                Log("!! Configuração incompleta: " + string.Join("; ", problems));
                serverLabel.Text = "CONFIGURAÇÃO INCOMPLETA";
                serverLabel.ForeColor = Color.Tomato;
            }
            else
            {
                serverLabel.Text = config.User + "@" + config.Host + ":" + config.Port + " (não testado)";
            }
            Log("Arraste uma pasta ou .zip do projeto sobre esta janela para usá-lo como origem.");
        }

        void BuildUi()
        {
            var title = new Label
            {
                Text = "ATUALIZADOR T4",
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(120, 200, 255),
                Left = 16, Top = 12, Width = 400, Height = 32,
            };

            var projectLabel = new Label { Text = "Projeto:", Left = 16, Top = 56, Width = 60 };
            projectBox = new TextBox
            {
                Left = 80, Top = 53, Width = 560,
                BackColor = Color.FromArgb(28, 31, 37), ForeColor = Color.Gainsboro,
                BorderStyle = BorderStyle.FixedSingle,
            };
            var browse = new Button { Text = "Escolher…", Left = 650, Top = 52, Width = 90, Height = 24 };
            browse.Click += (s, e) =>
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "Selecione a pasta do projeto T4";
                    if (dialog.ShowDialog() == DialogResult.OK) projectBox.Text = dialog.SelectedPath;
                }
            };

            var serverCaption = new Label { Text = "Servidor:", Left = 16, Top = 86, Width = 60 };
            serverLabel = new Label { Left = 80, Top = 86, Width = 660, ForeColor = Color.Gainsboro };

            updateButton = new Button
            {
                Text = "ATUALIZAR SITE", Left = 16, Top = 116, Width = 200, Height = 40,
                BackColor = Color.FromArgb(30, 90, 140), ForeColor = Color.White, FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            };
            updateButton.Click += (s, e) => StartDeploy();

            testButton = new Button { Text = "TESTAR CONEXÃO", Left = 228, Top = 116, Width = 150, Height = 40, FlatStyle = FlatStyle.Flat };
            testButton.Click += (s, e) => StartTest();

            rollbackButton = new Button { Text = "REVERTER ÚLTIMA VERSÃO", Left = 390, Top = 116, Width = 210, Height = 40, FlatStyle = FlatStyle.Flat };
            rollbackButton.Click += (s, e) => StartRollback();

            logButton = new Button { Text = "VER LOG", Left = 612, Top = 116, Width = 128, Height = 40, FlatStyle = FlatStyle.Flat };
            logButton.Click += (s, e) =>
            {
                try { Process.Start("notepad.exe", logPath); }
                catch (Exception ex) { Log("!! Não foi possível abrir o log: " + ex.Message); }
            };

            var progressLabel = new Label { Text = "Progresso:", Left = 16, Top = 168, Width = 100 };
            stepsBox = new ListBox
            {
                Left = 16, Top = 190, Width = 240, Height = 180,
                BackColor = Color.FromArgb(28, 31, 37), ForeColor = Color.Gainsboro,
                BorderStyle = BorderStyle.FixedSingle, SelectionMode = SelectionMode.None,
            };
            for (var i = 0; i < stepNames.Length; i++)
            {
                stepIndex[stepNames[i]] = i;
                stepsBox.Items.Add("· " + stepNames[i]);
            }

            logBox = new TextBox
            {
                Left = 268, Top = 190, Width = 560, Height = 370,
                Multiline = true, ScrollBars = ScrollBars.Vertical, ReadOnly = true,
                BackColor = Color.FromArgb(12, 14, 17), ForeColor = Color.FromArgb(190, 200, 210),
                Font = new Font("Consolas", 8.5f), BorderStyle = BorderStyle.FixedSingle,
            };

            var hint = new Label
            {
                Left = 16, Top = 380, Width = 240, Height = 180,
                ForeColor = Color.FromArgb(140, 150, 160),
                Text = "A versão no ar continua servindo\ndurante todo o processo.\n\n"
                     + "O symlink 'current' só troca\ndepois do build passar na VPS.\n\n"
                     + "Falha em build, PM2 ou health\ndevolve o release anterior\nautomaticamente.\n\n"
                     + ".env, banco e node_modules\nnunca são enviados.",
            };

            Controls.AddRange(new Control[]
            {
                title, projectLabel, projectBox, browse, serverCaption, serverLabel,
                updateButton, testButton, rollbackButton, logButton,
                progressLabel, stepsBox, logBox, hint,
            });
        }

        void OnDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
        }

        void OnDragDrop(object sender, DragEventArgs e)
        {
            var paths = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (paths != null && paths.Length > 0)
            {
                projectBox.Text = paths[0];
                Log("Origem definida por arrastar: " + paths[0]);
            }
        }

        void Log(string message)
        {
            var line = DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "  " + message;
            lock (logLock)
            {
                try { File.AppendAllText(logPath, line + Environment.NewLine, Encoding.UTF8); }
                catch { }
            }
            if (logBox.InvokeRequired) { logBox.BeginInvoke((Action)(() => AppendLog(line))); }
            else AppendLog(line);
        }

        void AppendLog(string line)
        {
            logBox.AppendText(line + Environment.NewLine);
        }

        void Step(string name, string state)
        {
            Action apply = () =>
            {
                int index;
                if (!stepIndex.TryGetValue(name, out index)) return;
                var mark = state == "OK" || state == "PASS" || state == "CONECTADO"
                           || state == "RESTAURADO" || state == "CONCLUÍDO"
                    ? "OK"
                    : state == "FALHOU" || state == "FAIL" ? "XX" : "..";
                stepsBox.Items[index] = mark + " " + name + " — " + state;
            };
            if (stepsBox.InvokeRequired) stepsBox.BeginInvoke(apply);
            else apply();
        }

        void SetBusy(bool busy)
        {
            running = busy;
            Action apply = () =>
            {
                updateButton.Enabled = !busy;
                testButton.Enabled = !busy;
                rollbackButton.Enabled = !busy;
            };
            if (InvokeRequired) BeginInvoke(apply); else apply();
        }

        bool GuardBusy()
        {
            if (!running) return false;
            MessageBox.Show("Já existe uma operação em andamento.", "Atualizador T4",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return true;
        }

        void StartTest()
        {
            if (GuardBusy()) return;
            var problems = config.Validate();
            if (problems.Count > 0)
            {
                MessageBox.Show("Configuração incompleta:\n\n" + string.Join("\n", problems),
                    "Atualizador T4", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            SetBusy(true);
            new Thread(() =>
            {
                try
                {
                    var deployer = new Deployer(config, Log, Step);
                    string output;
                    var ok = deployer.TestConnection(out output);
                    Log(ok ? "Conexão SSH validada." : "!! Conexão SSH falhou.");
                    if (ok)
                    {
                        BeginInvoke((Action)(() =>
                        {
                            serverLabel.Text = config.User + "@" + config.Host + ":" + config.Port + " — CONECTADO";
                            serverLabel.ForeColor = Color.LightGreen;
                        }));
                    }
                }
                finally { SetBusy(false); }
            }) { IsBackground = true }.Start();
        }

        void StartRollback()
        {
            if (GuardBusy()) return;
            if (MessageBox.Show(
                    "Voltar o site para o release anterior?\n\nO PM2 será recarregado.",
                    "Reverter", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                return;

            SetBusy(true);
            new Thread(() =>
            {
                try
                {
                    var deployer = new Deployer(config, Log, Step);
                    string output;
                    // O anterior é o penúltimo por data em releases/.
                    var script = "ls -1t " + config.RemotePath + "/releases | sed -n '2p'";
                    if (!deployer.Ssh(script, 30000, out output))
                    {
                        Log("!! Não foi possível listar releases.");
                        return;
                    }
                    var previous = output.Split('\n').Select(l => l.Trim())
                        .LastOrDefault(l => l.Length > 0 && !l.StartsWith("$") && !l.StartsWith("  "));
                    if (string.IsNullOrEmpty(previous))
                    {
                        // A saída vem prefixada com "  " pelo logger; tenta de novo sem filtro.
                        previous = output.Split('\n').Select(l => l.Trim())
                            .LastOrDefault(l => l.Length > 0 && !l.StartsWith("$"));
                    }
                    if (string.IsNullOrEmpty(previous))
                    {
                        Log("!! Nenhum release anterior encontrado.");
                        return;
                    }
                    Log("Revertendo para release " + previous);
                    string rollbackOut;
                    var ok = deployer.Rollback(config.RemotePath + "/releases/" + previous, out rollbackOut);
                    if (ok)
                    {
                        string healthOut;
                        var healthy = deployer.HealthCheck(out healthOut);
                        Log(healthy
                            ? "Reversão concluída e health OK."
                            : "!! Revertido, mas o health continua falhando. Investigue o servidor.");
                    }
                }
                finally { SetBusy(false); }
            }) { IsBackground = true }.Start();
        }

        void StartDeploy()
        {
            if (GuardBusy()) return;

            var problems = config.Validate();
            if (problems.Count > 0)
            {
                MessageBox.Show("Configuração incompleta:\n\n" + string.Join("\n", problems)
                    + "\n\nEdite " + configPath, "Atualizador T4",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var project = projectBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(project))
            {
                MessageBox.Show("Escolha a pasta do projeto (ou arraste um .zip sobre a janela).",
                    "Atualizador T4", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            SetBusy(true);
            new Thread(() => Deploy(project)) { IsBackground = true }.Start();
        }

        string PrepareSource(string project)
        {
            if (Directory.Exists(project)) return project;

            if (File.Exists(project) && project.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                var extractTo = Path.Combine(Path.GetTempPath(),
                    "t4-src-" + DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture));
                Directory.CreateDirectory(extractTo);
                Log("Extraindo " + project + " para " + extractTo);
                string output;
                var runner = new Runner(Log);
                if (runner.Run("tar", "-x -f \"" + project + "\" -C \"" + extractTo + "\"", null, out output, 300000) != 0)
                {
                    Log("!! Falha ao extrair o .zip.");
                    return null;
                }
                // Zip com uma única pasta raiz: entra nela.
                var entries = Directory.GetFileSystemEntries(extractTo);
                if (entries.Length == 1 && Directory.Exists(entries[0])) return entries[0];
                return extractTo;
            }

            Log("!! Caminho não é pasta nem .zip: " + project);
            return null;
        }

        void Deploy(string project)
        {
            var deployer = new Deployer(config, Log, Step);
            string archive = null;
            try
            {
                Log("==================================================");
                Log("Deploy iniciado.");

                var source = PrepareSource(project);
                if (source == null) { Fail("Origem inválida."); return; }

                if (!File.Exists(Path.Combine(source, "package.json")))
                {
                    Fail("package.json não encontrado em " + source + " — isso não é o projeto T4.");
                    return;
                }
                Log("Origem validada: " + source);

                string output;
                if (!deployer.TestConnection(out output)) { Fail("Conexão SSH falhou."); return; }

                var release = DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
                archive = Path.Combine(Path.GetTempPath(), "t4-" + release + ".tar.gz");

                if (!deployer.Package(source, archive, out output)) { Fail("Empacotamento falhou."); return; }
                Log("Pacote: " + archive + " (" + new FileInfo(archive).Length / 1024 + " KB)");

                // O "backup" é o próprio esquema de releases: a versão atual
                // permanece intacta no disco e o symlink pode voltar a ela.
                Step("Backup", "release anterior preservado em releases/");

                var remoteTmp = "/tmp/t4-" + release + ".tar.gz";
                if (!deployer.Upload(archive, remoteTmp, out output)) { Fail("Envio falhou."); return; }

                if (!deployer.BuildRelease(release, remoteTmp, out output))
                {
                    Fail("Build falhou na VPS — o site NÃO foi trocado e continua no ar.");
                    return;
                }

                string previous;
                if (!deployer.Promote(release, out previous, out output))
                {
                    Fail("PM2 falhou ao promover.");
                    deployer.Rollback(previous, out output);
                    return;
                }

                if (!deployer.HealthCheck(out output))
                {
                    Log("!! Health check falhou após o deploy — revertendo.");
                    string rollbackOut;
                    deployer.Rollback(previous, out rollbackOut);
                    string recheck;
                    var recovered = deployer.HealthCheck(out recheck);
                    Fail(recovered
                        ? "Deploy revertido: a versão anterior voltou e está saudável."
                        : "Deploy revertido, MAS a versão anterior também não passa no health. Investigue o servidor.");
                    return;
                }

                string pruneOut;
                deployer.Prune(out pruneOut);

                Step("Concluído", "CONCLUÍDO");
                Log("SUCESSO — release " + release + " está no ar e passou no health check.");
                BeginInvoke((Action)(() => MessageBox.Show(
                    "Site atualizado com sucesso.\n\nRelease: " + release,
                    "Atualizador T4", MessageBoxButtons.OK, MessageBoxIcon.Information)));
            }
            catch (Exception ex)
            {
                Fail("Erro inesperado: " + ex.Message);
                Log(ex.ToString());
            }
            finally
            {
                if (archive != null) { try { File.Delete(archive); } catch { } }
                SetBusy(false);
            }
        }

        void Fail(string message)
        {
            Log("!! " + message);
            Step("Concluído", "FALHOU");
            BeginInvoke((Action)(() => MessageBox.Show(message + "\n\nVeja o log para o detalhe.",
                "Atualizador T4 — ERRO", MessageBoxButtons.OK, MessageBoxIcon.Error)));
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // Duas atualizações simultâneas produziriam dois releases disputando
            // o mesmo symlink. O mutex é global: vale para toda a máquina.
            bool created;
            using (var mutex = new Mutex(true, "Global\\AtualizadorT4_SingleInstance", out created))
            {
                if (!created)
                {
                    MessageBox.Show("Já existe um Atualizador T4 aberto.", "Atualizador T4",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var exeDir = Path.GetDirectoryName(Application.ExecutablePath) ?? ".";
                var configPath = Path.Combine(exeDir, "updater.config.json");
                var config = Config.Load(configPath);
                var dropped = args.Length > 0 ? args[0] : null;

                Application.Run(new MainForm(config, configPath, dropped));
            }
        }
    }
}
