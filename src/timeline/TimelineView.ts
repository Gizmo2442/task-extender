import { View, WorkspaceLeaf, moment, TFile, App, debounce } from 'obsidian';
import type TaskPlannerPlugin from '../main';
import { TaskManager } from './TaskManager';
import { TimeBlockManager } from './TimeBlockManager';
import { TimeBlockModal, setupSplitter } from './TimelineComponents';
import { zoom } from './TimelineUtils';
import type { ITimelineView } from './TimelineInterfaces';

export class TimelineView extends View implements ITimelineView {
    private plugin: TaskPlannerPlugin;
    private timelineEl: HTMLElement;
    private timeSlots: Map<number, HTMLElement> = new Map();
    private currentDayFile: TFile | null = null;
    private isCreatingTimeBlock: boolean = false;
    private timeBlockStart: number | null = null;
    private modifiedFiles: Set<string> = new Set();
    private hourHeight: number = 80;
    private minHourHeight: number = 40;
    private maxHourHeight: number = 200;
    private taskManager: TaskManager;
    private timeBlockManager: TimeBlockManager;
    private debouncedRefresh: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: TaskPlannerPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.taskManager = new TaskManager(this.app, this);
        this.timeBlockManager = new TimeBlockManager(this.app, this, this.hourHeight);
        this.debouncedRefresh = debounce(this.refreshView.bind(this), 1000, true);
    }

    getViewType(): string {
        return 'timeline-view';
    }

    getDisplayText(): string {
        return 'Task Timeline';
    }

    getPlugin(): TaskPlannerPlugin {
        return this.plugin;
    }

    getTimelineEl(): HTMLElement {
        return this.timelineEl;
    }

    getCurrentDayFile(): TFile | null {
        return this.currentDayFile;
    }

    getTaskManager(): TaskManager {
        return this.taskManager;
    }

    async onOpen() {
        const { containerEl } = this;
        containerEl.empty();
        
        // Create main container
        const mainContainer = containerEl.createEl('div', { cls: 'timeline-main-container' });
        
        // Create header
        const headerEl = mainContainer.createEl('div', { cls: 'timeline-header' });
        headerEl.createEl('h4', { text: `Timeline for ${moment().format('MMMM D, YYYY')}` });
        
        // Create controls
        const controlsEl = headerEl.createEl('div', { cls: 'timeline-controls' });
        const refreshBtn = controlsEl.createEl('button', { text: '🔄' });
        refreshBtn.setAttribute('title', 'Refresh Timeline');
        refreshBtn.addEventListener('click', async () => {
            this.taskManager.clearCaches();
            await this.refreshView();
        });

        // Create timeline container
        this.timelineEl = mainContainer.createEl('div', { cls: 'timeline-container' });
        
        // Create splitter
        const splitter = mainContainer.createEl('div', { cls: 'timeline-splitter' });
        
        // Create unscheduled tasks area
        const unscheduledArea = mainContainer.createEl('div', { cls: 'unscheduled-tasks' });
        unscheduledArea.createEl('h6', { text: 'Unscheduled Tasks' });
        const dropZone = unscheduledArea.createEl('div', { 
            cls: 'unscheduled-drop-zone',
            attr: { 'data-time': 'unscheduled' }
        });
        this.setupDropZone(dropZone);

        // Setup splitter drag functionality
        setupSplitter(splitter, this.timelineEl, unscheduledArea);

        // Create time slots
        this.createTimeSlots();
        
        // Register file change handler
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    // Always clear the file cache and mark file as modified for markdown files
                    this.taskManager.getFileCache().delete(file.path);
                    this.modifiedFiles.add(file.path);
                    
                    // Schedule a debounced refresh to pick up any new tasks
                    this.debouncedRefresh();
                }
            })
        );

        // Initial load
        await this.refreshView();
    }

    private createTimeSlots() {
        for (let hour = 0; hour < 24; hour++) {
            const timeSlot = this.timelineEl.createEl('div', { cls: 'time-slot' });
            timeSlot.style.height = `${this.hourHeight}px`;
            
            const timeLabel = timeSlot.createEl('div', { 
                cls: 'time-label',
                text: `${hour.toString().padStart(2, '0')}:00`
            });
            
            const dropZone = timeSlot.createEl('div', { 
                cls: 'time-drop-zone',
                attr: { 'data-hour': hour.toString() }
            });

            // Add time block creation handlers
            dropZone.addEventListener('mousedown', (e) => {
                this.isCreatingTimeBlock = true;
                this.timeBlockStart = hour;
            });

            dropZone.addEventListener('mouseover', (e) => {
                if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                    this.showTimeBlockPreview(this.timeBlockStart, hour);
                }
            });
            
            this.timeSlots.set(hour, dropZone);
        }

        // Add mouseup handler to document
        document.addEventListener('mouseup', async (e) => {
            if (this.isCreatingTimeBlock && this.timeBlockStart !== null) {
                // Get the current hour from the element under the mouse
                const element = document.elementFromPoint(e.clientX, e.clientY);
                const currentHour = element?.closest('.time-drop-zone')?.getAttribute('data-hour');
                
                await this.createNewTimeBlock(
                    this.timeBlockStart,
                    currentHour ? parseInt(currentHour) : this.timeBlockStart
                );
                
                this.isCreatingTimeBlock = false;
                this.timeBlockStart = null;
            }
        });

        // Add scroll zoom handler to timeline container
        this.timelineEl.addEventListener('wheel', (e: WheelEvent) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                // Pass the relative Y position of the mouse in the container
                const rect = this.timelineEl.getBoundingClientRect();
                const mouseY = e.clientY - rect.top;
                this.hourHeight = zoom(
                    this.hourHeight,
                    zoomFactor,
                    mouseY,
                    this.timelineEl,
                    this.timeBlockManager.getTimeBlocks(),
                    this.minHourHeight,
                    this.maxHourHeight
                );
            }
        });
    }

    private setupDropZone(element: HTMLElement) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.addClass('drag-over');
        });

        element.addEventListener('dragleave', () => {
            element.removeClass('drag-over');
        });

        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.removeClass('drag-over');
            const taskText = e.dataTransfer?.getData('text/plain');
            const timeSlot = element.dataset.time;
            
            if (taskText && timeSlot) {
                const taskKey = this.taskManager.getTaskIdentity(taskText).identifier;
                const oldTaskEl = this.containerEl.querySelector(`[data-task="${taskKey}"]`);
                
                if (oldTaskEl) {
                    oldTaskEl.remove();
                }

                const taskIdentity = this.taskManager.getTaskIdentity(taskText);
                await this.taskManager.createTaskElement(taskText, taskIdentity);
            }
        });
    }

    private async createNewTimeBlock(startHour: number, endHour: number) {
        const modal = new TimeBlockModal(this.app);
        const title = await modal.openAndGetValue();
        if (!title) return;

        const id = `block-${Date.now()}`;
        const timeBlock = {
            id,
            title,
            startHour: Math.min(startHour, endHour),
            endHour: Math.max(startHour, endHour) + 1,  // +1 because end hour is exclusive
            tasks: []
        };

        this.timeBlockManager.getTimeBlocks().set(id, timeBlock);
        this.timeBlockManager.renderTimeBlock(timeBlock, this.timelineEl);
        await this.timeBlockManager.saveTimeBlocks(this.currentDayFile);
    }

    private showTimeBlockPreview(startHour: number, currentHour: number) {
        // Remove any existing preview
        const existingPreview = this.timelineEl.querySelector('.time-block-preview');
        if (existingPreview) {
            existingPreview.remove();
        }

        // Create preview element
        const previewEl = document.createElement('div');
        previewEl.addClass('time-block-preview', 'time-block');
        
        // Calculate position
        const start = Math.min(startHour, currentHour);
        const end = Math.max(startHour, currentHour) + 1;
        const top = start * this.hourHeight;
        const height = (end - start) * this.hourHeight;
        
        previewEl.style.top = `${top}px`;
        previewEl.style.height = `${height}px`;
        
        this.timelineEl.appendChild(previewEl);
    }

    private async refreshView() {
        // Store current scroll position
        const scrollPosition = this.timelineEl.scrollTop;

        try {
            // Load data in parallel
            await Promise.all([
                this.loadScheduledTasks(),
                this.timeBlockManager.loadTimeBlocks(this.currentDayFile),
                this.loadTasks()
            ]);

            // Find the unscheduled drop zone
            const unscheduledDropZone = this.containerEl.querySelector('.unscheduled-drop-zone');
            if (unscheduledDropZone) {
                unscheduledDropZone.empty();
                
                // Add unscheduled tasks to the unscheduled drop zone
                this.taskManager.getTaskElements().forEach((taskEl, identifier) => {
                    let isScheduled = false;
                    this.timeBlockManager.getTimeBlocks().forEach(block => {
                        if (block.tasks.includes(identifier)) {
                            isScheduled = true;
                        }
                    });

                    if (!isScheduled) {
                        const clonedTask = taskEl.cloneNode(true) as HTMLElement;
                        this.taskManager.setupTaskDragListeners(clonedTask, identifier);
                        unscheduledDropZone.appendChild(clonedTask);
                    }
                });
            }
            
            // Restore scroll position
            this.timelineEl.scrollTop = scrollPosition;
            
        } catch (error) {
            console.error('Error refreshing timeline view:', error);
        }
    }

    private async loadTasks() {
        const today = moment().format('YYYY-MM-DD');
        
        // If this is the initial load, process all files
        if (this.taskManager.getTaskCache().size === 0) {
            const files = this.app.vault.getMarkdownFiles();
            
            for (const file of files) {
                await this.processFile(file, today);
            }
        } else {
            // For subsequent loads, only process modified files
            const modifiedFiles = Array.from(this.modifiedFiles)
                .map(path => this.app.vault.getAbstractFileByPath(path))
                .filter((file): file is TFile => file instanceof TFile);
                
            for (const file of modifiedFiles) {
                await this.processFile(file, today);
            }
            
            // Clear the modified files set after processing
            this.modifiedFiles.clear();
        }
    }

    private async processFile(file: TFile, today: string) {
        const content = await this.app.vault.read(file);
        this.taskManager.getFileCache().set(file.path, content);
        
        // Keep track of tasks that existed in this file
        const previousTasksInFile = new Set(
            Array.from(this.taskManager.getTaskCache().values())
                .filter(task => task.filePath === file.path)
                .map(task => task.identifier)
        );
        
        // Process new/updated tasks in the file
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.match(/^- \[[ x]\]/)) {
                const taskIdentity = this.taskManager.getTaskIdentity(line);
                taskIdentity.filePath = file.path;
                
                const existingTask = this.taskManager.getTaskCache().get(taskIdentity.identifier);
                if (!existingTask ||
                    existingTask.originalContent !== taskIdentity.originalContent) {
                    
                    this.taskManager.getTaskCache().set(taskIdentity.identifier, taskIdentity);
                    
                    if (taskIdentity.metadata.dueDate && 
                        moment(taskIdentity.metadata.dueDate).format('YYYY-MM-DD') === today) {
                        await this.taskManager.createTaskElement(line, taskIdentity);
                    }
                }
                previousTasksInFile.delete(taskIdentity.identifier);
            }
        }
        
        // Remove tasks that no longer exist in this file
        for (const taskId of previousTasksInFile) {
            const task = this.taskManager.getTaskCache().get(taskId);
            if (task && task.filePath === file.path) {
                this.taskManager.getTaskCache().delete(taskId);
                const taskEl = this.taskManager.getTaskElements().get(taskId);
                if (taskEl) {
                    taskEl.remove();
                    this.taskManager.getTaskElements().delete(taskId);
                }
            }
        }
    }

    private async loadScheduledTasks() {
        const today = moment().format('YYYY-MM-DD');
        const dailyNotes = this.app.vault.getMarkdownFiles().filter(file => 
            file.basename === today
        );

        if (dailyNotes.length > 0) {
            this.currentDayFile = dailyNotes[0];
        } else {
            // Create today's file if it doesn't exist
            this.currentDayFile = await this.app.vault.create(
                `${today}.md`,
                '# ' + moment().format('MMMM D, YYYY') + '\n\n```timeBlocks\n{}\n```'
            );
        }
    }

    onunload() {
        this.taskManager.clearCaches();
    }
} 